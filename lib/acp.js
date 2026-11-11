/**
 * ACP-over-stdio transport for one remote subagent task.
 *
 * The peer is a DSH `acp` profile, either local (`dsh --profile acp`) or on
 * another machine over SSH (`ssh <host> -- sh -c 'exec dsh --profile acp'`).
 * One task = one ACP session: initialize -> session/new -> session/prompt ->
 * session/update* -> stopReason, then session/close and process teardown.
 *
 * Protocol facts (verified against @deepseek-ai/dsh-acp 0.2.1-rc.2):
 *   - newline-delimited JSON-RPC 2.0 on stdin/stdout; stdout carries protocol only
 *   - agent -> client request `session/request_permission` MUST be answered or the
 *     remote tool call hangs; DSH offers option ids `allow-once` / `reject-once`
 *     and a response shape of `{ outcome: { outcome: 'selected', optionId } }`
 *   - cancel is the `session/cancel` notification; `$ /cancel_request` aborts the
 *     in-flight JSON-RPC request at the protocol layer
 *
 * Node builtins only: this file must import nothing from the DSH installation so
 * the plugin can be mounted from an absolute path without a profile farm entry.
 */
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const PROTOCOL_VERSION = 1
const IS_WINDOWS = process.platform === 'win32'
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Environment names that look like credentials (mirrors the official provider's
 * posture, widened to `*_KEY`, `*_AUTH`, cookies, sessions and DSNs).
 */
const CREDENTIAL_ENV = /(?:^|_)(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH|COOKIE|SESSION|DSN)(?:$|_)/i
/** Credential-shaped exact names that do not contain a separator. */
const CREDENTIAL_EXACT = /^(?:DATABASE_URL|REDIS_URL|MONGODB_URI|MONGO_URI)$/i
/** Variables the peer legitimately needs from the parent (ssh agent forwarding). */
const KEEP_ENV = new Set(['SSH_AUTH_SOCK'])

/**
 * Remove credential-shaped variables from a child environment.
 *
 * The peer is another agent runtime, not this process: handing it the parent's
 * API keys/tokens is an unnecessary disclosure surface (official providers scrub
 * the same way and require credentials to be stated explicitly).
 *
 * @param {Record<string, string|undefined>} env source environment
 * @returns {{env: Record<string, string>, removed: string[]}}
 */
export function scrubEnv(env) {
  const kept = {}
  const removed = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue
    if (KEEP_ENV.has(key)) {
      kept[key] = String(value)
    } else if (CREDENTIAL_ENV.test(key) || CREDENTIAL_EXACT.test(key)) {
      removed.push(key)
    } else {
      kept[key] = String(value)
    }
  }
  return { env: kept, removed }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8Lenient = new TextDecoder('utf-8')
let gbkDecoder

/**
 * Decode bytes with the first encoding that fits: UTF-8, then GBK (zh-CN
 * Windows console), then latin1.
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeBytes(buffer) {
  try {
    return utf8Strict.decode(buffer)
  } catch {
    try {
      gbkDecoder ??= new TextDecoder('gbk')
      return gbkDecoder.decode(buffer)
    } catch {
      return buffer.toString('latin1')
    }
  }
}

/**
 * Windows OpenSSH escapes non-ASCII console text as C octal escapes when its
 * stderr is a pipe (`\262\273\326\252…`). Those are GBK byte values spelled as
 * ASCII, so turn them back into the characters a user can read; unusable bytes
 * stay as the original escape text.
 * @param {string} text
 * @returns {string}
 */
function unescapeOctalText(text) {
  if (!/\\[0-7]{3}/.test(text)) return text
  return text.replace(/(?:\\[0-7]{3})+/g, (match) => {
    const bytes = []
    for (const part of match.matchAll(/\\([0-7]{3})/g)) bytes.push(Number.parseInt(part[1], 8))
    const decoded = decodeBytes(Buffer.from(bytes))
    return decoded.includes('\uFFFD') ? match : decoded
  })
}

/**
 * Decode one peer stderr line without assuming UTF-8.
 *
 * The peer is usually a local `ssh` client: on a zh-CN Windows console its own
 * diagnostics (DNS failure, host-key prompts) are GBK bytes — and when stderr is
 * a pipe OpenSSH spells them as octal escapes — while a remote command's stderr
 * is UTF-8. Decode bytes, unescape the octal spelling, and strip control
 * characters so the text is safe to put into a JSON diagnostic.
 *
 * @param {Buffer|string} line raw readline payload
 * @returns {string}
 */
export function decodePeerStderr(line) {
  const buffer = Buffer.isBuffer(line) ? line : Buffer.from(String(line), 'utf8')
  return unescapeOctalText(decodeBytes(buffer)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

class RpcError extends Error {
  constructor(method, error) {
    const detail = error !== null && typeof error === 'object'
      ? `${error.code} ${error.message}${error.data === undefined ? '' : ` data=${JSON.stringify(error.data)}`}`
      : String(error)
    super(`${method} failed: ${detail}`)
    this.name = 'RpcError'
    this.method = method
    this.rpc = error
  }
}

/**
 * Candidate `dsh` shims found on PATH (Windows shims are .cmd/.bat/.exe files).
 * The plugin must not hardcode any machine-specific install path.
 * @returns {string[]}
 */
function dshShimCandidatesOnPath() {
  const pathValue = process.env.PATH || ''
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const out = []
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue
    for (const ext of extensions) out.push(path.join(dir, `dsh${ext.toLowerCase()}`))
    out.push(path.join(dir, 'dsh'))
  }
  return out
}

/**
 * Resolve the local DSH launch command from the CLI shim.
 * Spawning the `.cmd` wrapper through cmd.exe would orphan the real Electron
 * peer on kill, so parse the shim into `exe + cli.js` and spawn that directly.
 * @returns {{command: string, args: string[], env: Record<string,string>}|undefined}
 */
export function resolveLocalDsh() {
  if (!IS_WINDOWS) {
    const bin = process.env.DSH_BIN || 'dsh'
    return { command: bin, args: ['--profile', 'acp'], env: {} }
  }
  const candidates = [
    process.env.DSH_CLI_SHIM,
    process.env.DSH_BIN,
    ...dshShimCandidatesOnPath(),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const shim of candidates) {
    try {
      const text = fs.readFileSync(shim, 'utf8')
      const exeMatch = text.match(/"([^"]+?\.exe)"/i)
      const jsMatch = text.match(/"([^"]+?\.asar[^"]*?cli\.js)"/i)
      if (exeMatch !== null && jsMatch !== null) {
        const base = path.dirname(shim)
        const resolve = (token) => path.resolve(token.replace(/%~dp0/gi, `${base}${path.sep}`))
        return {
          command: resolve(exeMatch[1]),
          args: ['--expose-internals', resolve(jsMatch[1])],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Quote one argv token for a POSIX `sh -c` command line.
 * @param {string} value
 * @returns {string}
 */
function shQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote one argv token for a Windows `cmd.exe` command line.
 *
 * Windows OpenSSH runs the command through `cmd.exe`, which does not understand
 * POSIX single quotes. Tokens without whitespace or cmd metacharacters are
 * passed as-is; everything else is double-quoted (cmd only treats redirection
 * and chaining characters specially outside double quotes).
 * @param {string} value
 * @returns {string}
 */
function cmdQuote(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"&|<>^()%!]/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

/**
 * Build the remote command line for a Windows endpoint.
 *
 * Windows OpenSSH's default shell is `cmd.exe`; there is no POSIX `sh -c`
 * layer, so the whole line is handed to cmd as one argument. The POSIX pid
 * probe (`$$`) does not exist here, which only makes remote reaping best-effort:
 * ACP itself runs over stdio and does not need it.
 * @param {object} endpoint normalized host config
 * @returns {string}
 */
export function buildWindowsRemoteShell(endpoint) {
  const args = endpoint.remoteArgs || ['--profile', 'acp']
  const command = endpoint.remoteCommand || 'dsh'
  return [command, ...args].map(cmdQuote).join(' ')
}

/**
 * Build the child process spec for an endpoint.
 * @param {object} endpoint normalized host config
 * @returns {{command: string, args: string[], env: Record<string,string>, label: string}}
 */
export function buildSpawn(endpoint) {
  if (endpoint.mode === 'local') {
    const profileArgs = ['--profile', endpoint.profile || 'acp']
    // An explicit localCommand wins: deployments that ship dsh at a custom path
    // (and the transport tests, which point it at a fixture) must not be
    // overridden by the detected CLI shim.
    if (typeof endpoint.localCommand === 'string' && endpoint.localCommand.length > 0) {
      return {
        command: endpoint.localCommand,
        args: [...(endpoint.localArgs || []), ...profileArgs],
        env: {},
        label: `${endpoint.localCommand} ${[...(endpoint.localArgs || []), ...profileArgs].join(' ')}`,
      }
    }
    const resolved = resolveLocalDsh()
    if (resolved !== undefined) {
      return {
        command: resolved.command,
        args: [...resolved.args, ...profileArgs],
        env: resolved.env,
        label: `${path.basename(resolved.command)} ${resolved.args.join(' ')} ${profileArgs.join(' ')}`,
      }
    }
    return {
      command: 'dsh',
      args: profileArgs,
      env: {},
      label: `dsh ${profileArgs.join(' ')}`,
    }
  }

  // SSH: keep stdout pure JSON-RPC. The POSIX carrier runs the peer under
  // `sh -c` and prints its pid to stderr for best-effort reaping; the Windows
  // carrier hands a cmd-safe command line straight to the remote cmd.exe.
  const sshArgs = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    ...(endpoint.sshArgs || []),
    endpoint.sshHost,
    '--',
  ]
  if (endpoint.remoteShell === 'cmd') {
    const remoteShell = buildWindowsRemoteShell(endpoint)
    return {
      command: endpoint.sshBin || 'ssh',
      args: [...sshArgs, remoteShell],
      env: {},
      label: `ssh -T ${endpoint.sshHost} -- ${remoteShell}`,
    }
  }
  const remoteArgs = [
    ...(endpoint.remoteArgs || ['--profile', 'acp']),
  ].map(shQuote).join(' ')
  const remoteCommand = shQuote(endpoint.remoteCommand || 'dsh')
  const remoteShell = `sh -c ${shQuote(`echo DSH_ACP_PID=$$ >&2; exec ${remoteCommand} ${remoteArgs}`)}`
  return {
    command: endpoint.sshBin || 'ssh',
    args: [...sshArgs, remoteShell],
    env: {},
    label: `ssh -T ${endpoint.sshHost} -- ${remoteShell}`,
  }
}

/**
 * Human-readable endpoint label for diagnostics.
 * @param {object} endpoint
 * @returns {string}
 */
export function describeEndpoint(endpoint) {
  if (endpoint.mode === 'local') return `local:${endpoint.profile || 'acp'}`
  return `ssh:${endpoint.sshHost}${endpoint.cwd === undefined ? '' : `:${endpoint.cwd}`}`
}

class RemoteAcpRun {
  constructor(options) {
    this.options = options
    this.endpoint = options.endpoint
    this.child = null
    this.exitInfo = { code: null, signal: null }
    this.exitWaiters = []
    this.nextId = 0
    this.pending = new Map()
    this.sessionId = null
    this.remotePid = null
    this.messages = new Map()
    this.messageOrder = []
    this.toolCalls = new Map()
    this.toolCallOrder = []
    this.permissionLog = []
    this.usage = []
    this.updates = {}
    this.stderrTail = []
    this.stdoutNoise = []
    this.startedAt = Date.now()
    this.cancelRequested = false
    this.timeoutRequested = false
    this.promptPromise = null
    this.promptRequestId = null
    this.promptResult = undefined
    this.closed = false
    /** First protocol-integrity violation (unknown request, session mismatch, ...). */
    this.protocolError = undefined
    /** `initialize.agentInfo`, kept for diagnostics/version checks. */
    this.agentInfo = undefined
    /** Credential-shaped env names removed before spawning the peer. */
    this.envScrubbed = []
    /** Teardown failure retained for diagnostics (never changes the result). */
    this.teardownError = undefined
    /** Whether `session/close` was sent (false when the host keeps the session). */
    this.sessionClosed = false
    /**
     * Pipe-level failures from the peer (EPIPE on stdin, read errors on
     * stdout/stderr). Recorded for diagnostics, never rethrown: an unhandled
     * stream 'error' becomes a process-level uncaughtException and would take
     * the whole DSH Host down with it (2026-11-11 incident).
     */
    this.stdinError = undefined
    this.stdoutError = undefined
    this.stderrError = undefined
  }

  get alive() {
    return this.child !== null && this.exitInfo.code === null && this.exitInfo.signal === null
  }

  // ---------------------------------------------------------------- process

  start() {
    const spec = buildSpawn(this.endpoint)
    this.spec = spec
    // Scrub credential-shaped variables before handing the environment to another
    // agent runtime, then layer the explicit host env on top (official providers
    // take the same posture: explicit env only, never inherited API keys).
    const base = this.options.scrubEnv === true ? scrubEnv(process.env) : { env: { ...process.env }, removed: [] }
    this.envScrubbed = base.removed
    const env = { ...base.env, ...spec.env, ...(this.options.env ?? {}) }
    this.child = spawn(spec.command, spec.args, {
      shell: false,
      cwd: this.endpoint.spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8')
    // stderr is NOT forced to utf8: Windows OpenSSH emits localized messages in
    // the console code page (GBK on zh-CN), and decoding those as UTF-8 produced
    // unreadable octal escapes in diagnostics. Keep bytes, sniff the encoding.
    this.stdoutLines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.stderrLines = createInterface({ input: this.child.stderr, crlfDelay: Infinity })
    this.stdoutLines.on('line', (line) => this.onStdoutLine(line))
    this.stderrLines.on('line', (line) => this.onStderrLine(line))
    // The peer can die between an `alive` check and an in-flight write; the
    // resulting EPIPE arrives as a stream/readline 'error' event. Readline
    // re-emits input errors on the interface, so both levels need a listener.
    this.child.stdin.on('error', (error) => {
      this.stdinError = error
      this.rejectAllPending(new Error(`ACP peer stdin closed: ${error.code || error.message}`))
    })
    this.child.stdout.on('error', (error) => {
      this.stdoutError = error
    })
    this.child.stderr.on('error', (error) => {
      this.stderrError = error
    })
    this.stdoutLines.on('error', (error) => {
      this.stdoutError = error
    })
    this.stderrLines.on('error', (error) => {
      this.stderrError = error
    })
    this.child.on('error', (error) => {
      this.rejectAllPending(new Error(`ACP peer failed to start: ${error.message}`))
      this.markExit(null, null)
    })
    this.child.on('exit', (code, signal) => {
      this.rejectAllPending(new Error(`ACP peer exited before answering (code=${code} signal=${signal})`))
      this.markExit(code, signal)
    })
    return this
  }

  markExit(code, signal) {
    if (this.exitInfo.code !== null || this.exitInfo.signal !== null) return
    this.exitInfo = { code, signal, at: Date.now() }
    for (const waiter of this.exitWaiters.splice(0)) waiter(this.exitInfo)
  }

  onStdoutLine(line) {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      this.stdoutNoise.push(trimmed.slice(0, 300))
      return
    }
    this.dispatch(message)
  }

  onStderrLine(line) {
    const text = decodePeerStderr(line)
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const pidMatch = /DSH_ACP_PID=(\d+)/.exec(trimmed)
    if (pidMatch !== null) this.remotePid = Number(pidMatch[1])
    this.stderrTail.push(trimmed.slice(0, 500))
    if (this.stderrTail.length > 80) this.stderrTail.shift()
    if (this.stdoutNoise.length > 32) this.stdoutNoise.shift()
  }

  dispatch(message) {
    if (message.id !== undefined && message.method === undefined) {
      const slot = this.pending.get(message.id)
      if (slot === undefined) return
      this.pending.delete(message.id)
      if (slot.timer !== undefined) clearTimeout(slot.timer)
      if (message.error !== undefined) slot.reject(new RpcError(slot.method, message.error))
      else slot.resolve(message.result)
      return
    }
    if (message.method !== undefined && message.id !== undefined) {
      void this.onServerRequest(message)
      return
    }
    if (message.method === 'session/update') {
      this.onSessionUpdate(message.params || {})
    }
  }

  writeFrame(frame) {
    if (!this.alive || this.child.stdin.destroyed) throw new Error('ACP peer is not running')
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8')
    } catch (error) {
      const detail = error && (error.code || error.message) ? error.code || error.message : String(error)
      throw new Error(`ACP peer stdin write failed: ${detail}`)
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId + 1
    this.nextId = id
    const promise = new Promise((resolve, reject) => {
      const slot = { id, method, resolve, reject, timer: undefined }
      if (timeoutMs !== undefined && timeoutMs > 0) {
        slot.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.pending.set(id, slot)
      try {
        this.writeFrame({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        if (slot.timer !== undefined) clearTimeout(slot.timer)
        reject(error)
      }
    })
    return { id, promise }
  }

  notify(method, params) {
    this.writeFrame({ jsonrpc: '2.0', method, params })
  }

  respond(id, body) {
    this.writeFrame({ jsonrpc: '2.0', id, ...body })
  }

  rejectAllPending(error) {
    for (const [, slot] of this.pending) {
      if (slot.timer !== undefined) clearTimeout(slot.timer)
      slot.reject(error)
    }
    this.pending.clear()
  }

  /**
   * Fail the whole run on a protocol-integrity violation.
   *
   * The official providers treat unknown/foreign protocol frames as fatal rather
   * than best-effort skipping: continuing would mean settling a result from a
   * peer whose messages we cannot attribute. The first violation wins; pending
   * requests are rejected so `prompt()` unwinds promptly.
   * @param {string} message human-readable violation
   */
  failProtocol(message) {
    if (this.protocolError !== undefined) return
    this.protocolError = message
    this.rejectAllPending(new Error(`ACP protocol violation: ${message}`))
    if (this.sessionId !== null && this.alive) {
      try {
        this.notify('session/cancel', { sessionId: this.sessionId })
      } catch {
        // Teardown will kill the peer.
      }
    }
  }

  // -------------------------------------------------------------- ACP flow

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-subagent-remote', title: 'DSH remote subagent provider', version: PACKAGE_VERSION },
    }, 120000).promise
    this.serverInfo = result || {}
    this.agentInfo = this.serverInfo.agentInfo
    const expected = this.options.expectAgentName
    if (typeof expected === 'string' && expected.length > 0) {
      const observed = typeof this.agentInfo?.name === 'string' ? this.agentInfo.name : '(none)'
      if (observed !== expected) {
        throw new Error(`remote ACP peer is not the expected agent: expected "${expected}", observed "${observed}"`)
      }
    }
    return this.serverInfo
  }

  async newSession() {
    const result = await this.request('session/new', {
      cwd: this.endpoint.cwd,
      mcpServers: [],
    }, 180000).promise
    this.sessionId = result?.sessionId ?? null
    if (this.sessionId === null) throw new Error('session/new returned no sessionId')
    return result
  }

  onSessionUpdate(params) {
    // A notification that names another session must not be attributed to this
    // run: treat it as a protocol violation instead of silently folding it in.
    if (this.sessionId !== null && params.sessionId !== undefined && params.sessionId !== this.sessionId) {
      this.failProtocol(`session/update referenced another session: ${String(params.sessionId)}`)
      return
    }
    const update = params.update || {}
    const kind = String(update.sessionUpdate || 'unknown')
    this.updates[kind] = (this.updates[kind] || 0) + 1
    // Live observer for host-side UI/state; it must never break the run.
    if (typeof this.options.onUpdate === 'function') {
      try {
        this.options.onUpdate(kind, update, params)
      } catch {
        // Observers are advisory only.
      }
    }
    switch (kind) {
      case 'agent_message_chunk': {
        if (update.content?.type !== 'text') return
        const messageId = update.messageId ?? '__anonymous__'
        if (!this.messages.has(messageId)) {
          this.messages.set(messageId, '')
          this.messageOrder.push(messageId)
        }
        this.messages.set(messageId, this.messages.get(messageId) + (update.content.text || ''))
        return
      }
      case 'tool_call': {
        const call = {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          rawInput: update.rawInput,
        }
        this.toolCalls.set(call.toolCallId, call)
        this.toolCallOrder.push(call)
        return
      }
      case 'tool_call_update': {
        const existing = this.toolCalls.get(update.toolCallId)
        if (existing !== undefined) {
          if (update.title !== undefined) existing.title = update.title
          if (update.rawInput !== undefined) existing.rawInput = update.rawInput
          if (update.status !== undefined) existing.status = update.status
        }
        return
      }
      case 'usage_update': {
        this.usage.push({ used: update.used, size: update.size })
        return
      }
      default:
        return
    }
  }

  async onServerRequest(message) {
    if (message.method !== 'session/request_permission') {
      // Answer so the peer is not left waiting, and fail the run: an unknown
      // server request means this client cannot honour the peer's contract.
      try {
        this.respond(message.id, { error: { code: -32601, message: `client does not implement ${message.method}` } })
      } catch {
        // A dead peer is handled by teardown.
      }
      this.failProtocol(`unsupported server request: ${String(message.method)}`)
      return
    }
    const params = message.params || {}
    const toolCallId = params.toolCall?.toolCallId
    // DSH drains queued session/update frames before asking, but tolerate interleaving.
    let call = toolCallId === undefined ? undefined : this.toolCalls.get(toolCallId)
    for (let i = 0; call === undefined && i < 20; i += 1) {
      await sleep(50)
      call = toolCallId === undefined ? undefined : this.toolCalls.get(toolCallId)
    }

    let decision
    try {
      decision = await this.options.decide({ call, options: params.options, toolCallId })
    } catch (error) {
      decision = { allow: false, reason: `policy error: ${String(error?.message ?? error)}`, source: 'policy-error' }
    }
    const option = decision.allow
      ? pickAllow(params.options)
      : pickReject(params.options)
    const outcome = option === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
    this.permissionLog.push({
      toolCallId,
      tool: call?.title ?? null,
      input: call?.rawInput ?? null,
      decision: decision.allow ? 'allow' : 'reject',
      reason: decision.reason,
      source: decision.source,
      answeredWith: option?.optionId ?? 'cancelled',
    })
    this.respond(message.id, { result: outcome })
  }

  /**
   * Send the prompt and wait for the ACP stopReason. Timeout and parent abort
   * both go through `session/cancel` and then bound the wait.
   * @returns {Promise<{stopReason?: string}|undefined>}
   */
  async prompt() {
    const { id, promise } = this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: this.options.promptText }],
    })
    this.promptRequestId = id
    this.promptPromise = promise
    const deadline = Date.now() + this.options.timeoutMs
    const onAbort = () => {
      if (this.settling) return
      this.cancelRequested = true
      this.requestCancel(this.options.abortReason || 'parent aborted the subagent')
    }
    if (this.options.signal !== undefined) {
      if (this.options.signal.aborted) onAbort()
      else this.options.signal.addEventListener('abort', onAbort, { once: true })
      this.removeAbort = () => this.options.signal.removeEventListener('abort', onAbort)
    }

    let watchdogDone = false
    let watchdogTimer
    let watchdogWake
    const outcome = await Promise.race([
      promise.then((value) => ({ kind: 'result', value }), (error) => ({ kind: 'error', error })),
      (async () => {
        while (!watchdogDone && Date.now() < deadline) {
          if (this.cancelRequested) return { kind: 'cancelled' }
          await new Promise((resolve) => {
            watchdogWake = resolve
            watchdogTimer = setTimeout(resolve, 250)
          })
        }
        if (watchdogDone) return { kind: 'stopped' }
        this.timeoutRequested = true
        this.requestCancel(`remote subagent exceeded ${this.options.timeoutMs}ms`)
        return { kind: 'timeout' }
      })(),
    ])
    // The losing racer must not leave a live timer behind: a pending 250 ms
    // timer keeps the host event loop alive after a one-shot turn ends (headless
    // runs then hang until the whole prompt budget expires). Stop it here.
    watchdogDone = true
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer)
    watchdogWake?.()

    if (outcome.kind === 'cancelled' || outcome.kind === 'timeout') {
      // Give the remote a bounded grace period to settle the prompt request.
      // Clear the losing timer for the same event-loop reason as the watchdog.
      let graceTimer
      const grace = await Promise.race([
        promise.then((value) => ({ kind: 'result', value }), () => ({ kind: 'error' })),
        new Promise((resolve) => {
          graceTimer = setTimeout(() => resolve({ kind: 'late' }), 8000)
        }),
      ])
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      if (grace.kind === 'result') this.promptResult = grace.value
      return this.promptResult
    }
    if (outcome.kind === 'error') throw outcome.error
    this.promptResult = outcome.value
    return this.promptResult
  }

  requestCancel(reason) {
    this.cancelReason = reason
    if (this.sessionId === null || !this.alive) return
    try {
      this.notify('session/cancel', { sessionId: this.sessionId })
    } catch {
      // A dead peer is handled by teardown.
    }
  }

  /**
   * Last assistant message text (DSH's closing message for the parent notice).
   * @returns {string}
   */
  closingText() {
    for (let i = this.messageOrder.length - 1; i >= 0; i -= 1) {
      const text = this.messages.get(this.messageOrder[i])
      if (typeof text === 'string' && text.trim().length > 0) return text.trim()
    }
    return ''
  }

  async closeSession() {
    if (this.sessionId === null || !this.alive) return
    try {
      await this.request('session/close', { sessionId: this.sessionId }, 20000).promise
      this.sessionClosed = true
    } catch {
      // Best effort: teardown still closes stdin and kills the peer.
    }
  }

  waitExit(ms) {
    if (this.exitInfo.code !== null || this.exitInfo.signal !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      this.exitWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  killTree(force) {
    if (this.child?.pid === undefined) return
    try {
      if (IS_WINDOWS) {
        execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {})
      } else {
        this.child.kill(force ? 'SIGKILL' : 'SIGTERM')
      }
    } catch {
      // Ignore kill races.
    }
  }

  async teardown() {
    if (this.closed) return
    this.closed = true
    this.settling = true
    this.removeAbort?.()
    try {
      // `remoteSession: keep` skips the graceful ACP close so the target keeps
      // the persisted session (its history stays resumable); the transport still
      // tears the process down either way.
      if (this.options.closeRemoteSession !== false && this.sessionId !== null && this.alive) await this.closeSession()
      try {
        if (this.child !== null && !this.child.stdin.destroyed) this.child.stdin.end()
      } catch {
        // Ignore a stdin already closed by the peer.
      }
      let exited = await this.waitExit(this.options.disposeGraceMs)
      if (!exited && this.alive) {
        this.killTree(false)
        exited = await this.waitExit(4000)
        if (!exited && this.alive) {
          this.killTree(true)
          await this.waitExit(3000)
        }
      }
      await this.reapRemote()
    } catch (error) {
      this.teardownError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * After the SSH client is gone, verify the remote `dsh --profile acp` process
   * really exited; TERM/KILL it only when it is still alive.
   */
  async reapRemote() {
    if (this.endpoint.mode !== 'ssh' || this.remotePid === null) return
    // A peer could report anything; never target init (1) or a non-positive pid.
    if (!Number.isInteger(this.remotePid) || this.remotePid <= 1) return
    const sshBase = [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      ...(this.endpoint.sshArgs || []),
      this.endpoint.sshHost,
      '--',
    ]
    try {
      const check = `sh -c ${shQuote(`kill -0 ${this.remotePid} 2>/dev/null && echo ALIVE || echo GONE`)}`
      const { stdout } = await execFileP('ssh', [...sshBase, check], { timeout: 20000, windowsHide: true })
      if (!/\bALIVE\b/.test(String(stdout))) return
      const kill = `sh -c ${shQuote(`kill -TERM ${this.remotePid} 2>/dev/null; sleep 1; kill -KILL ${this.remotePid} 2>/dev/null; echo REAPED`)}`
      await execFileP('ssh', [...sshBase, kill], { timeout: 25000, windowsHide: true })
    } catch {
      // Reaping is best effort; the remote peer normally exits when ssh closes stdin.
    }
  }
}

/** Prefer option kind, fall back to the DSH option ids. */
function pickAllow(options) {
  const list = Array.isArray(options) ? options : []
  return list.find((option) => option?.kind === 'allow_once')
    ?? list.find((option) => option?.kind === 'allow_always')
    ?? list.find((option) => option?.optionId === 'allow-once')
}
function pickReject(options) {
  const list = Array.isArray(options) ? options : []
  return list.find((option) => option?.kind === 'reject_once')
    ?? list.find((option) => option?.kind === 'reject_always')
    ?? list.find((option) => option?.optionId === 'reject-once')
}

/**
 * Run exactly one ACP session against the endpoint and settle the outcome.
 *
 * @param {object} options
 * @param {object} options.endpoint normalized host config (mode/sshHost/cwd/...)
 * @param {string} options.promptText task text sent as the single user prompt
 * @param {number} [options.timeoutMs] prompt budget
 * @param {(input: object) => Promise<{allow: boolean, reason: string, source: string}>} options.decide permission decider
 * @param {AbortSignal} [options.signal] parent cancellation
 * @returns {Promise<{text: string, stopReason: string, remoteSessionId: string|null, permissionLog: object[], toolCalls: object[], updates: object, usage: object[], stderrTail: string[], stdoutNoise: string[], durationMs: number, promptStopReason: string|undefined}>}
 */
export async function runRemoteTask(options) {
  const run = new RemoteAcpRun({
    timeoutMs: 600000,
    ...options,
    // Teardown grace is a deployment choice; local peers die quickly, SSH needs
    // longer for the remote side to notice EOF.
    disposeGraceMs: options.disposeGraceMs ?? (options.endpoint?.mode === 'ssh' ? 10000 : 5000),
  })
  const started = Date.now()
  let stage = 'spawn'
  let outcome
  try {
    run.start()
    stage = 'initialize'
    await run.initialize()
    stage = 'session-new'
    await run.newSession()
    stage = 'prompt'
    const promptResult = await run.prompt()
    const text = run.closingText()
    let stopReason
    if (run.cancelRequested || run.timeoutRequested) stopReason = 'aborted'
    else if (promptResult?.stopReason === 'cancelled') stopReason = 'aborted'
    else if (promptResult?.stopReason === 'max_tokens') stopReason = 'max-tokens'
    else if (promptResult?.stopReason === 'refusal') stopReason = 'refusal'
    else if (text.length === 0) stopReason = 'error'
    else stopReason = 'completed'

    outcome = {
      text,
      stopReason,
      remoteSessionId: run.sessionId,
      permissionLog: run.permissionLog,
      toolCalls: run.toolCallOrder,
      updates: run.updates,
      usage: run.usage,
      stderrTail: run.stderrTail,
      stdoutNoise: run.stdoutNoise,
      durationMs: Date.now() - started,
      promptStopReason: promptResult?.stopReason,
      spawnLabel: run.spec?.label,
      serverInfo: run.serverInfo,
      agentInfo: run.agentInfo,
      endpoint: describeEndpoint(run.endpoint),
      envScrubbed: run.envScrubbed,
      protocolError: run.protocolError,
      sessionClosed: run.sessionClosed,
    }
    if (stopReason === 'error' && text.length === 0) outcome.failureStage = 'prompt'
  } catch (error) {
    outcome = {
      text: run.closingText(),
      stopReason: run.cancelRequested ? 'aborted' : 'error',
      remoteSessionId: run.sessionId,
      permissionLog: run.permissionLog,
      toolCalls: run.toolCallOrder,
      updates: run.updates,
      usage: run.usage,
      stderrTail: run.stderrTail,
      stdoutNoise: run.stdoutNoise,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      failureStage: stage,
      serverInfo: run.serverInfo,
      agentInfo: run.agentInfo,
      endpoint: describeEndpoint(run.endpoint),
      spawnLabel: run.spec?.label,
      envScrubbed: run.envScrubbed,
      protocolError: run.protocolError,
      sessionClosed: run.sessionClosed,
    }
  } finally {
    try {
      await run.teardown()
    } catch {
      // Teardown must not change the settled result.
    }
  }
  // Transport facts for diagnostics (only known after teardown).
  outcome.sessionClosed = run.sessionClosed
  outcome.peerExit = run.exitInfo
  outcome.peerPid = run.child?.pid ?? null
  if (run.teardownError !== undefined) outcome.teardownError = run.teardownError
  return outcome
}


