/**
 * dsh-subagent-remote — remote (cross-machine) subagent provider for DeepSeek Harness.
 *
 * Shape: a zero-dependency Cordis plugin that registers one OUT-OF-PROCESS subagent
 * provider per configured host. A delegation on that provider runs one ACP session
 * against a DSH `acp` profile on the target machine (locally or over SSH), then
 * settles the remote assistant's closing message as the subagent result.
 *
 * Contract implemented (DSH 0.2.1-rc.2, see research/provider-contract.md):
 *   ctx.subagents.registerProvider({ name, capabilities, inheritsParentContext, start })
 *   start(request) -> Promise<{ id, result: Promise<SubagentResult>, dispose }>
 *   SubagentResult  = { output: ContentBlock[], stopReason, diagnostic? }
 *   success stopReason is 'completed' (NOT 'end'); `result` never rejects.
 *
 * Engineering norms are aligned with the official out-of-process backends
 * (`@deepseek-ai/dsh-subagent-codex`): explicit unsupported-server-request failure,
 * request validation before the process boundary, credential-shaped env scrubbing,
 * fixed failure category facts, safe diagnostics by default, and debug-only raw
 * payloads. See research/official-codex-backend/STUDY.md.
 *
 * Permission policy (default `read-only`): ACP permission prompts from the remote
 * are answered locally; `ask` routes write/execute requests to the local approval
 * seam and fails closed when no answerer is available.
 */
import { randomUUID } from 'node:crypto'
import { runRemoteTask } from './lib/acp.js'
import { createPermissionDecider, requestRunPreAuthorization } from './lib/policy.js'
import { buildUnifiedRemoteTool } from './lib/tool.js'
import { RPC_PATH, applyHostOverlay, readState, registerSettingsRpc, writeState } from './lib/settings.js'
import { createRunRegistry } from './lib/runs.js'
import { recoverJournal, saveJournal } from './lib/journal.js'

/** Out-of-process backends cannot honor parent-enforced start features. */
const CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

const DIAGNOSTIC_LIMIT = 4096
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_DISPOSE_GRACE_MS = 60 * 1000

export const name = 'dsh-subagent-remote'
export const inject = ['subagents']

/** Accepted permission modes; anything else is a config error, not a silent fallback. */
export const PERMISSION_MODES = Object.freeze(['read-only', 'ask', 'deny', 'auto'])

/** Accepted remote shell carriers; anything else is a config error. */
export const REMOTE_SHELLS = Object.freeze(['posix', 'cmd'])

/** Machine-readable failure categories (mirrors the official backends' fixed sets). */
export const FAILURE_CATEGORIES = Object.freeze([
  'invalid-request',
  'protocol',
  'transport',
  'auth',
  'host-key',
  'dns',
  'remote-workspace',
  'credential',
  'product-error',
  'invalid-result',
  'process',
  'teardown',
  'unknown',
])

/**
 * Per-session host selection with a persisted/config default fallback.
 *
 * Resolution order for a delegation without an explicit `host`: session
 * selection (`/remote-host <name>`) → persisted default (settings page) →
 * plugin-config `defaultHost` → the only configured host (when exactly one).
 *
 * @param {object[]} hosts normalized hosts
 * @param {{configDefault?: string, readPersistedDefault?: () => string|undefined}} [options]
 */
export function createHostSelection(hosts, options = {}) {
  const names = hosts.map((host) => host.name)
  const bySession = new Map()
  const readPersisted = typeof options.readPersistedDefault === 'function' ? options.readPersistedDefault : () => undefined
  const configDefault = options.configDefault
  const base = () => {
    const persisted = readPersisted()
    if (typeof persisted === 'string' && names.includes(persisted)) return persisted
    if (typeof configDefault === 'string' && names.includes(configDefault)) return configDefault
    return names.length === 1 ? names[0] : undefined
  }
  const sessionOf = (parentOrId) => (typeof parentOrId === 'string' ? parentOrId : parentOrId?.session?.id)
  return {
    names,
    base,
    resolve(parent) {
      const sessionId = sessionOf(parent)
      if (sessionId !== undefined && bySession.has(sessionId)) return bySession.get(sessionId)
      return base()
    },
    select(sessionId, name) {
      if (!names.includes(name)) throw new Error(`unknown remote host "${name}" (configured: ${names.join(', ')})`)
      bySession.set(sessionId ?? '__global__', name)
      return name
    },
    clear(sessionId) {
      bySession.delete(sessionId ?? '__global__')
    },
    current(sessionId) {
      if (sessionId !== undefined && bySession.has(sessionId)) return bySession.get(sessionId)
      return bySession.get('__global__') ?? base()
    },
  }
}

/**
 * Render the `/remote-host` listing text.
 * @param {object[]} hosts normalized hosts
 * @param {ReturnType<typeof createHostSelection>} selection
 * @param {string|undefined} sessionId current session
 * @returns {string}
 */
export function describeHostSwitcher(hosts, selection, sessionId) {
  if (hosts.length === 0) return '未配置远端主机（hosts 为空）'
  const current = selection.current(sessionId)
  const lines = [`远端主机（当前：${current ?? '未选择'}）`]
  for (const host of hosts) {
    const endpoint = host.mode === 'local' ? `local:${host.profile ?? 'acp'}` : `ssh:${host.sshHost}`
    const marker = host.name === current ? '  ← 当前' : ''
    lines.push(`- ${host.name}  ${endpoint}  cwd=${host.cwd}  permission=${host.permission}  remoteSession=${host.remoteSession ?? 'close'}${marker}`)
  }
  lines.push('用法：/remote-host <名字> 切换本会话；/remote-host reset 清除；省略参数只看列表。')
  return lines.join('\n')
}

/**
 * Reject an ssh destination that would be parsed as an ssh option (leading "-"),
 * contain whitespace/control characters, or otherwise escape argv semantics.
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function assertSshDestination(value, label) {
  const text = String(value ?? '')
  if (text.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  if (/^[\s-]/.test(text)) throw new Error(`${label} must not start with a dash or whitespace`)
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain whitespace or control characters`)
  return text
}

/**
 * Reject ssh options that turn a probe/delegation into local command execution.
 * @param {string[]|undefined} args
 * @param {string} label
 * @returns {string[]|undefined}
 */
function assertSafeSshArgs(args, label) {
  if (args === undefined) return undefined
  for (const arg of args) {
    if (/^(?:-o\s*)?(?:ProxyCommand|LocalCommand|Match|Include)\b/i.test(arg) || /^(?:-F|\-S)\b/i.test(arg)) {
      throw new Error(`${label} must not set ${arg}; remove it from the host definition`)
    }
  }
  return args
}

/**
 * Windows absolute path check used by remoteShell auto-detection and by the
 * session-cwd choice (a Windows workspace cannot accept the parent's POSIX cwd).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWindowsAbsolutePath(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Parent session id for the session-header run indicator.
 *
 * The provider `start(request)` receives the exact live parent Agent
 * (`request.parent`), whose durable session carries the id. Older/alternate
 * shapes are tolerated so the indicator degrades to "unscoped" rather than
 * throwing inside the provider seam.
 * @param {unknown} request provider request
 * @returns {string|null}
 */
export function parentSessionIdOf(request) {
  if (request === null || typeof request !== 'object') return null
  const parent = request.parent
  if (parent === null || typeof parent !== 'object') return null
  const id = parent.session?.id ?? parent.sessionId ?? parent.session?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Build the system-prompt section that makes every new session aware of the
 * remote-subagent capability without the user having to name the plugin.
 *
 * Dynamic on purpose: the registered section callback reads the live host
 * registry, so adding/removing hosts from the plugin page changes the next
 * prompt assembly. The text is intentionally short and action-oriented: the
 * model needs "when to use" plus the host capabilities, not a full manual.
 *
 * @param {object[]} hosts live normalized hosts
 * @param {string} [toolName]
 * @returns {string} empty when no host is enabled
 */
export function buildRemoteSubagentSection(hosts, toolName = 'remote_subagent') {
  const enabled = (Array.isArray(hosts) ? hosts : []).filter((host) => host !== null && typeof host === 'object' && host.disabled !== true)
  if (enabled.length === 0) return ''
  const lines = enabled.map((host) => {
    const parts = [`${host.name} — ${host.remoteShell === 'cmd' ? 'Windows' : 'POSIX'} remote`, `cwd ${host.cwd}`]
    if (typeof host.description === 'string' && host.description.length > 0) parts.push(host.description)
    if (typeof host.permission === 'string' && host.permission.length > 0) parts.push(`permission ${host.permission}`)
    return `- ${parts.join('; ')}`
  })
  return [
    `You can delegate one one-shot task to another machine with the ${toolName} tool.`,
    'Remote hosts:',
    ...lines,
    'Use this tool when the task needs one of those machines (its OS, shell, tools, workspace, files, models, or credentials), when the user names a host or asks to run/offload something there, or when the local session cannot satisfy the request. Prefer this tool over ad-hoc local ssh/bash commands to these hosts: it applies the configured permission policy, records diagnostics, and shows the run in the session header. Do not use it for work the local machine can do.',
    'The remote agent cannot see this conversation: include every fact and constraint it needs. This backend does not accept follow-up messages. After dispatching, do not poll (no list_agents/job_list), sleep, or start unrelated work just to wait: end the turn and wait for the runtime completion notice, which starts the next turn. Do not call send_message or any follow-up control for this one-shot remote subagent. Omit the host to use the session default (/remote-host to switch).',
  ].join('\n')
}

/**
 * Validate one optional string field.
 * @param {string} where field path for the diagnostic
 * @param {unknown} value
 * @returns {string|undefined}
 */
function optionalString(where, value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-subagent-remote: ${where} must be a non-empty string`)
  }
  return value
}

/**
 * Validate one optional string-array field.
 * @param {string} where field path for the diagnostic
 * @param {unknown} value
 * @returns {string[]|undefined}
 */
function optionalStringArray(where, value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`dsh-subagent-remote: ${where} must be an array of strings`)
  }
  return value.map(String)
}

/**
 * Validate one optional `Record<string,string>` env block.
 * @param {string} where field path for the diagnostic
 * @param {unknown} value
 * @returns {Record<string,string>|undefined}
 */
function optionalEnv(where, value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`dsh-subagent-remote: ${where} must be an object of string values`)
  }
  const env = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`dsh-subagent-remote: ${where}.${key} must be a string`)
    env[key] = item
  }
  return env
}

/**
 * Normalize the plugin config into host descriptors.
 * Accepts either `hosts: [...]` or a single host written as top-level fields.
 * Configuration errors are thrown at plugin load so the profile boot log names
 * the offending field instead of failing later inside `start()`.
 * @param {object|undefined} config
 * @returns {object[]}
 */
export function normalizeHosts(config) {
  const raw = config ?? {}
  if (raw.hosts !== undefined) {
    if (!Array.isArray(raw.hosts)) throw new Error('dsh-subagent-remote: "hosts" must be an array')
    // A bundle install starts with no hosts and fills them in from the plugin
    // page; the empty list is therefore a valid (if inert) configuration.
    if (raw.hosts.length === 0) return []
  }
  // `{}` (the bundle patch's default config) means "no hosts yet", not a
  // single anonymous host.
  if (raw.hosts === undefined && raw.ssh === undefined && raw.local !== true && raw.cwd === undefined) return []
  const entries = Array.isArray(raw.hosts) ? raw.hosts : [raw]
  const hosts = []
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`dsh-subagent-remote: hosts[${index}] must be an object`)
    }
    const local = entry.local === true
    if (!local && (typeof entry.ssh !== 'string' || entry.ssh.trim().length === 0)) {
      throw new Error(`dsh-subagent-remote: hosts[${index}] needs "ssh" (or "local: true")`)
    }
    if (typeof entry.cwd !== 'string' || !(entry.cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry.cwd))) {
      throw new Error(`dsh-subagent-remote: hosts[${index}].cwd must be an absolute path`)
    }
    // POSIX remotes get the `sh -c` carrier (pid probe on stderr); Windows
    // remotes must use the cmd carrier. A drive-letter workspace is a safe
    // auto-detection signal; an explicit remoteShell overrides it.
    const remoteShell = local
      ? 'posix'
      : (entry.remoteShell === undefined
          ? (isWindowsAbsolutePath(entry.cwd) ? 'cmd' : 'posix')
          : entry.remoteShell)
    if (!local && !REMOTE_SHELLS.includes(remoteShell)) {
      throw new Error(`dsh-subagent-remote: hosts[${index}].remoteShell must be one of ${REMOTE_SHELLS.join('|')} (got ${JSON.stringify(remoteShell)})`)
    }
    const permission = entry.permission === undefined ? 'read-only' : entry.permission
    if (!PERMISSION_MODES.includes(permission)) {
      throw new Error(`dsh-subagent-remote: hosts[${index}].permission must be one of ${PERMISSION_MODES.join('|')} (got ${JSON.stringify(permission)})`)
    }
    const remoteSession = entry.remoteSession === undefined ? 'close' : entry.remoteSession
    if (remoteSession !== 'close' && remoteSession !== 'keep') {
      throw new Error(`dsh-subagent-remote: hosts[${index}].remoteSession must be "close" or "keep" (got ${JSON.stringify(remoteSession)})`)
    }
    if (entry.timeoutMs !== undefined && !(Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0)) {
      throw new Error(`dsh-subagent-remote: hosts[${index}].timeoutMs must be a positive finite number`)
    }
    if (entry.disposeGraceMs !== undefined
      && !(Number.isFinite(entry.disposeGraceMs) && entry.disposeGraceMs > 0 && entry.disposeGraceMs <= MAX_DISPOSE_GRACE_MS)) {
      throw new Error(`dsh-subagent-remote: hosts[${index}].disposeGraceMs must be a positive number no greater than ${MAX_DISPOSE_GRACE_MS}`)
    }
    if (entry.scrubEnv !== undefined && typeof entry.scrubEnv !== 'boolean') {
      throw new Error(`dsh-subagent-remote: hosts[${index}].scrubEnv must be a boolean`)
    }
    const label = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : `host${index}`
    hosts.push({
      name: label,
      provider: typeof entry.provider === 'string' && entry.provider.length > 0 ? entry.provider : `remote-${label}`,
      description: optionalString(`hosts[${index}].description`, entry.description),
      mode: local ? 'local' : 'ssh',
      sshHost: local ? undefined : assertSshDestination(entry.ssh, `hosts[${index}].ssh`),
      sshBin: optionalString(`hosts[${index}].sshBin`, entry.sshBin),
      sshArgs: assertSafeSshArgs(optionalStringArray(`hosts[${index}].sshArgs`, entry.sshArgs), `hosts[${index}].sshArgs`),
      remoteCommand: optionalString(`hosts[${index}].remoteCommand`, entry.remoteCommand),
      remoteArgs: optionalStringArray(`hosts[${index}].remoteArgs`, entry.remoteArgs),
      remoteShell,
      profile: optionalString(`hosts[${index}].profile`, entry.profile),
      localCommand: optionalString(`hosts[${index}].localCommand`, entry.localCommand),
      localArgs: optionalStringArray(`hosts[${index}].localArgs`, entry.localArgs),
      cwd: entry.cwd,
      spawnCwd: optionalString(`hosts[${index}].spawnCwd`, entry.spawnCwd),
      permission,
      timeoutMs: entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs,
      // `keep` skips the graceful ACP session/close so the target retains the
      // persisted session; `close` (default) closes it before teardown.
      remoteSession,
      // SSH peers never need this process's API keys; a local DSH peer usually
      // does (it inherits the parent's provider configuration), so scrubbing is
      // opt-in there and defaults on only for SSH.
      scrubEnv: entry.scrubEnv === undefined ? !local : entry.scrubEnv,
      env: optionalEnv(`hosts[${index}].env`, entry.env),
      disposeGraceMs: entry.disposeGraceMs,
      expectAgentName: optionalString(`hosts[${index}].expectAgentName`, entry.expectAgentName),
    })
  }
  const seenHosts = new Set()
  const seenProviders = new Set()
  for (const host of hosts) {
    if (seenHosts.has(host.name)) throw new Error(`dsh-subagent-remote: duplicate host name "${host.name}"`)
    if (seenProviders.has(host.provider)) throw new Error(`dsh-subagent-remote: duplicate provider name "${host.provider}"`)
    seenHosts.add(host.name)
    seenProviders.add(host.provider)
  }
  return hosts
}

/**
 * Choose the workspace path sent to `session/new`.
 *
 * The manager always injects an absolute `request.cwd` (the parent's working
 * directory). That path belongs to THIS machine, so for an SSH host it is only
 * usable when it is a POSIX path the remote can enter; otherwise fall back to
 * the host's configured remote cwd. Without this, the first delegation from a
 * Windows parent to a Linux host fails `session/new` with
 * "cwd must be an absolute path" (observed in the first end-to-end run).
 *
 * A Windows **remote** has the mirror problem: a POSIX parent sends
 * `/private/tmp`, which looks usable but does not exist on the remote. When the
 * configured cwd is a drive-letter path, it is the only valid session cwd.
 *
 * Since `lib/tool.js` now always passes a cwd (the caller's, else the host's
 * configured workspace), this fallback only decides for callers that still let
 * the manager inject the parent cwd — legacy one-row-per-host configs and any
 * direct `startActivation` user. Two POSIX machines cannot be told apart by path
 * shape, which is why the tool no longer relies on this guess.
 *
 * @param {string|undefined} requested `request.cwd` from the manager
 * @param {string} fallback host-configured remote cwd
 * @param {'ssh'|'local'} mode
 * @returns {string}
 */
export function pickSessionCwd(requested, fallback, mode) {
  if (typeof requested !== 'string' || requested.length === 0) return fallback
  if (mode === 'local') return requested
  if (isWindowsAbsolutePath(fallback)) return fallback
  const looksPosix = requested.startsWith('/') && !/^[A-Za-z]:/.test(requested)
  return looksPosix ? requested : fallback
}

/**
 * Validate the delegation task before crossing the process boundary.
 *
 * The remote provider is a text-only one-shot backend: silently dropping image
 * or resource blocks (or sending an empty prompt) would make the remote answer a
 * different question than the parent asked, so refuse instead.
 *
 * @param {unknown} prompt manager-built content block array
 * @returns {string} the joined task text
 */
export function validateTaskPrompt(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error('the remote subagent task must contain at least one text block')
  }
  const texts = []
  for (const block of prompt) {
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      const kind = block !== null && typeof block === 'object' && typeof block.type === 'string' ? block.type : 'unknown'
      throw new Error(`the remote subagent task accepts text blocks only (got ${kind})`)
    }
    texts.push(block.text)
  }
  const text = texts.join('\n\n')
  if (text.trim().length === 0) throw new Error('the remote subagent task must not be empty')
  return text
}

/**
 * Turn a failure plus the captured stderr into short, actionable hints.
 * @param {{error?: string, stderrTail?: string[], mode?: 'ssh'|'local'}} facts
 * @returns {string[]}
 */
export function diagnoseFailure(facts) {
  const haystack = `${facts.error ?? ''}\n${(facts.stderrTail ?? []).join('\n')}`
  const hints = []
  const add = (hint) => {
    if (!hints.includes(hint)) hints.push(hint)
  }
  if (/ENOENT|not recognized as|command not found|is not found/i.test(haystack)) {
    add(facts.mode === 'ssh'
      ? 'SSH client not found: install OpenSSH or set hosts[].sshBin to an absolute path.'
      : 'Local dsh executable not found: set hosts[].localCommand to the CLI path.')
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(haystack)) {
    add('Host key is not trusted: connect once manually, or add sshArgs ["-o","StrictHostKeyChecking=accept-new"].')
  }
  if (/Permission denied \(publickey|no supported authentication methods/i.test(haystack)) {
    add('SSH auth failed for this workstation: use a relay host the target already trusts (see README "Relay"), or install this key on the target.')
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(haystack)) {
    add('SSH destination could not be resolved: check hosts[].ssh / sshArgs (alias, user@host, port).')
  }
  if (/cwd must be an absolute path|cwd is not an accessible directory|ENOENT.*session\/new/i.test(haystack)) {
    add('Remote workspace rejected: hosts[].cwd must be an absolute path that exists on the remote host.')
  }
  // A failure that already has an SSH/workspace-level explanation must not also
  // claim the ACP handshake is at fault — that hint only applies when the
  // transport itself came up.
  if (hints.length === 0 && /initialize timed out|session\/new timed out|peer exited before answering/i.test(haystack)) {
    add('Remote ACP peer did not finish the handshake: run `dsh --profile acp` manually on the target and check its stderr.')
  }
  if (/MISSING_CREDENTIAL|credential|api key|unauthorized|401/i.test(haystack)) {
    add('Remote DSH has no usable model credentials: configure ~/.dsh credentials (or the provider env) on the target.')
  }
  if (/EPERM|sandbox/i.test(haystack)) {
    add('The spawn was blocked by the local sandbox: the plugin must run in the DSH host process, not inside a sandboxed tool call.')
  }
  if (/not the expected agent/i.test(haystack)) {
    add('The remote peer is not the expected agent: check hosts[].expectAgentName or the remote profile.')
  }
  if (/unsupported server request|protocol violation/i.test(haystack)) {
    add('The remote peer asked for a protocol interaction this client does not implement; the run was failed closed instead of left hanging.')
  }
  return hints
}

/**
 * Classify one failed run into the fixed category/stage facts that go into the
 * parent-visible diagnostic (raw text stays debug-only).
 * @param {{error?: string, stderrTail?: string[], failureStage?: string, protocolError?: string}} facts
 * @returns {{stage: string, category: string}}
 */
export function classifyFailureFacts(facts) {
  const haystack = `${facts.error ?? ''}\n${facts.protocolError ?? ''}\n${(facts.stderrTail ?? []).join('\n')}`
  const stage = typeof facts.failureStage === 'string' && facts.failureStage.length > 0 ? facts.failureStage : 'unknown'
  const category = (() => {
    if (facts.protocolError !== undefined || /unsupported server request|protocol violation/i.test(haystack)) return 'protocol'
    if (/not the expected agent/i.test(haystack)) return 'protocol'
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(haystack)) return 'host-key'
    if (/Permission denied \(publickey|no supported authentication methods/i.test(haystack)) return 'auth'
    if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(haystack)) return 'dns'
    if (/cwd must be an absolute path|cwd is not an accessible directory/i.test(haystack)) return 'remote-workspace'
    if (/MISSING_CREDENTIAL|api key|unauthorized|\b401\b/i.test(haystack)) return 'credential'
    if (/completed without an answer|invalid-result/i.test(haystack)) return 'invalid-result'
    if (/ENOENT|not recognized as|command not found|is not found|EPERM|failed to start|peer exited before answering|initialize timed out|session\/new timed out/i.test(haystack)) return 'transport'
    if (/teardown/i.test(haystack)) return 'teardown'
    if (stage === 'prompt') return 'product-error'
    return 'unknown'
  })()
  return { stage, category }
}

/**
 * Whether raw failure payloads (error text, stderr tail, stdout noise) may be
 * included in the parent-visible diagnostic. Off by default: the remote is a
 * different trust domain, and official providers expose fixed facts only.
 * @returns {boolean}
 */
function debugDiagnosticsEnabled() {
  return process.env.DSH_SUBAGENT_REMOTE_DEBUG === '1'
}

/**
 * Validate the optional V2 `tool:` block.
 * @param {unknown} toolConfig
 * @returns {{name?: string, description?: string}|undefined}
 */
export function normalizeToolConfig(toolConfig) {
  if (toolConfig === undefined || toolConfig === null) return undefined
  if (typeof toolConfig !== 'object' || Array.isArray(toolConfig)) {
    throw new Error('dsh-subagent-remote: "tool" must be an object with optional name/description')
  }
  const name = optionalString('tool.name', toolConfig.name)
  const description = optionalString('tool.description', toolConfig.description)
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) }
}

/**
 * Render the provider diagnostic from the run facts, capped to the seam's limit.
 *
 * Default shape exposes fixed facts only (endpoint, stage/category, counts,
 * permission decisions, hints). Raw error text, stderr and stdout noise are
 * debug-only (`DSH_SUBAGENT_REMOTE_DEBUG=1`).
 *
 * @param {object} facts
 * @returns {string}
 */
export function renderDiagnostic(facts) {
  const debug = facts.debug === true
  const lines = []
  lines.push(`[dsh-subagent-remote] ${facts.endpoint} cwd=${facts.cwd}`)
  if (facts.stage !== undefined || facts.category !== undefined) {
    lines.push(`failure: stage=${String(facts.stage ?? 'unknown')} category=${String(facts.category ?? 'unknown')}`)
  }
  if (facts.invalid !== undefined) lines.push(`invalid: ${facts.invalid}`)
  if (debug && facts.error !== undefined) lines.push(`error: ${facts.error}`)
  lines.push(`stopReason=${facts.stopReason}${facts.promptStopReason === undefined ? '' : ` promptStopReason=${facts.promptStopReason}`} duration=${(facts.durationMs / 1000).toFixed(1)}s`)
  if (facts.agentInfo !== undefined && typeof facts.agentInfo === 'object') {
    const agentName = typeof facts.agentInfo.name === 'string' ? facts.agentInfo.name : '?'
    const agentVersion = typeof facts.agentInfo.version === 'string' ? facts.agentInfo.version : '?'
    lines.push(`agent=${agentName}/${agentVersion}`)
  }
  if (facts.remoteSessionId) lines.push(`remoteSession=${facts.remoteSessionId}`)
  if (facts.remoteSessionId && facts.sessionClosed !== undefined) lines.push(`remoteSessionAction=${facts.sessionClosed ? 'closed' : 'kept'}`)
  if (Array.isArray(facts.toolCalls) && facts.toolCalls.length > 0) {
    const names = facts.toolCalls.map((call) => call.title ?? '?')
    lines.push(`remoteTools=${facts.toolCalls.length} (${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''})`)
  }
  if (Array.isArray(facts.permissionLog) && facts.permissionLog.length > 0) {
    for (const permission of facts.permissionLog.slice(-8)) {
      lines.push(`permission=${permission.decision} tool=${permission.tool ?? '?'} reason=${permission.reason}`)
    }
  }
  if (facts.preAuth !== undefined) {
    lines.push(`preAuth=${facts.preAuth.granted === true ? 'granted' : 'not-granted'} (${facts.preAuth.reason})`)
  }
  if (Array.isArray(facts.usage) && facts.usage.length > 0) {
    const last = facts.usage[facts.usage.length - 1]
    lines.push(`remoteUsage=${String(last.used)}/${String(last.size)}`)
  }
  if (Array.isArray(facts.envScrubbed) && facts.envScrubbed.length > 0) {
    lines.push(debug ? `envScrubbed=${facts.envScrubbed.join(',')}` : `envScrubbed=${facts.envScrubbed.length}`)
  }
  if (facts.peerExit !== undefined && typeof facts.peerExit === 'object' && (facts.peerExit.code !== null || facts.peerExit.signal !== null)) {
    lines.push(`peerExit=code=${String(facts.peerExit.code)} signal=${String(facts.peerExit.signal)}${facts.peerPid === undefined ? '' : ` pid=${String(facts.peerPid)}`}`)
  }
  if (debug && Array.isArray(facts.stderrTail) && facts.stderrTail.length > 0) {
    const tail = facts.stderrTail.slice(-6)
    lines.push(`stderrTail=${tail.join(' | ').slice(0, 800)}`)
  }
  if (debug && Array.isArray(facts.stdoutNoise) && facts.stdoutNoise.length > 0) {
    lines.push(`stdoutNoise=${facts.stdoutNoise.slice(0, 3).join(' | ').slice(0, 400)}`)
  }
  if (debug && facts.teardownError !== undefined) lines.push(`teardownError=${String(facts.teardownError).slice(0, 300)}`)
  for (const hint of facts.hints ?? []) lines.push(`hint: ${hint}`)
  let text = lines.join('\n')
  if (Buffer.byteLength(text, 'utf8') > DIAGNOSTIC_LIMIT) {
    text = `${Buffer.from(text, 'utf8').subarray(0, DIAGNOSTIC_LIMIT - 32).toString('utf8')}\n[diagnostic truncated]`
  }
  return text
}

/**
 * Publish one external run for a host.
 * @param {object} ctx Cordis plugin context
 * @param {object} host normalized host descriptor
 * @param {object} request manager-built subagent request
 * @returns {Promise<{id: string, result: Promise<object>, dispose: () => Promise<void>}>}
 */
async function startRemoteRun(ctx, host, request, runs, onChange, control) {
  const id = randomUUID()
  const controller = new AbortController()
  // A user Stop is the same cooperative cancellation the parent signal uses; the
  // ACP peer is disposed and the run settles as `aborted`.
  control?.register?.(id, () => controller.abort('cancelled by the user from the session header'))
  const debug = debugDiagnosticsEnabled()
  let settled = false
  let resolveResult
  let disposal
  let taskPromise

  const result = new Promise((resolve) => {
    resolveResult = resolve
  })

  const cwd = pickSessionCwd(request.cwd, host.cwd, host.mode)
  const endpointLabel = host.mode === 'local' ? `local:${host.profile ?? 'acp'}` : `ssh:${host.sshHost}:${cwd}`
  const facts = {
    endpoint: endpointLabel,
    cwd,
    stopReason: 'error',
    durationMs: 0,
    debug,
  }

  // Session-header indicator state. The record is per process and bounded by
  // the registry's grace period; it never feeds the conversation itself.
  runs?.begin({
    id,
    sessionId: parentSessionIdOf(request),
    host: host.name,
    provider: host.provider,
    endpoint: endpointLabel,
    cwd,
    permission: host.permission,
    remoteSession: host.remoteSession ?? 'close',
  })
  onChange?.('sync')

  const settle = (outcome) => {
    if (settled) return
    settled = true
    control?.release?.(id)
    resolveResult(outcome)
  }

  // Validate the task before any process is spawned: refusing here keeps the
  // remote from answering a different question than the parent asked.
  let promptText
  try {
    promptText = validateTaskPrompt(request.prompt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    settle({
      output: [],
      stopReason: 'error',
      diagnostic: renderDiagnostic({
        ...facts,
        stage: 'dispatch',
        category: 'invalid-request',
        invalid: message,
        stopReason: 'error',
        hints: [],
      }),
    })
    ctx.logger?.warn?.(`[dsh-subagent-remote] ${host.provider}: rejected delegation: ${message}`)
    runs?.finish(id, { status: 'error', stopReason: 'error', error: message, text: '', durationMs: 0 })
    onChange?.('sync')
    return { id, result, dispose: () => Promise.resolve() }
  }

  const onParentAbort = () => {
    controller.abort(request.signal?.reason ?? 'parent aborted')
  }
  if (request.signal !== undefined) {
    if (request.signal.aborted) onParentAbort()
    else request.signal.addEventListener('abort', onParentAbort, { once: true })
  }

  // `ask` must decide at dispatch time: the approval seam is turn-enclosed and
  // the remote run outlives the delegating turn (see lib/policy.js).
  // A dispatch that throws before publishing must not leave a Stop handle behind.
  let decider
  try {
    if (host.permission === 'ask') {
      runs?.update(id, { phase: 'authorizing' })
      onChange?.('async')
      facts.preAuth = await requestRunPreAuthorization({
        ctx,
        request,
        providerName: host.provider,
        endpoint: endpointLabel,
      })
    }

    decider = createPermissionDecider({
      mode: host.permission,
      request,
      ctx,
      providerName: host.provider,
      preAuth: facts.preAuth,
    })
  } catch (error) {
    control?.release?.(id)
    throw error
  }

  taskPromise = (async () => {
    runs?.update(id, { phase: 'running' })
    onChange?.('async')
    const outcome = await runRemoteTask({
      endpoint: { ...host, cwd },
      promptText,
      timeoutMs: host.timeoutMs,
      decide: decider,
      signal: controller.signal,
      abortReason: 'parent cancelled the remote subagent',
      scrubEnv: host.scrubEnv,
      env: host.env,
      disposeGraceMs: host.disposeGraceMs,
      expectAgentName: host.expectAgentName,
      closeRemoteSession: host.remoteSession !== 'keep',
      onUpdate: (kind, update) => {
        runs?.progress(id, kind, update)
        onChange?.('async')
      },
    })
    Object.assign(facts, outcome)
    const output = outcome.text.length > 0 ? [{ type: 'text', text: outcome.text }] : []
    const failed = outcome.stopReason === 'error' || outcome.error !== undefined
    const classified = failed ? classifyFailureFacts(outcome) : undefined
    runs?.finish(id, {
      status: outcome.stopReason === 'completed' ? 'completed' : outcome.stopReason === 'aborted' ? 'aborted' : 'error',
      stopReason: outcome.stopReason,
      durationMs: outcome.durationMs,
      toolCalls: Array.isArray(outcome.toolCalls) ? outcome.toolCalls.length : undefined,
      text: outcome.text,
      remoteSessionId: outcome.remoteSessionId ?? null,
      usage: Array.isArray(outcome.usage) && outcome.usage.length > 0 ? outcome.usage[outcome.usage.length - 1] : null,
      error: failed ? (outcome.error ?? classified?.category ?? 'remote run failed') : null,
    })
    onChange?.('sync')
    return {
      output,
      stopReason: outcome.stopReason,
      diagnostic: renderDiagnostic({
        ...facts,
        ...outcome,
        ...(classified === undefined ? {} : { stage: classified.stage, category: classified.category }),
        ...(failed ? { hints: diagnoseFailure({ error: outcome.error, stderrTail: outcome.stderrTail, mode: host.mode }) } : {}),
      }),
    }
  })().then(
    (settledResult) => {
      settle(settledResult)
      return settledResult
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error)
      const classified = classifyFailureFacts({ error: message, stderrTail: facts.stderrTail })
      const failed = {
        output: [],
        stopReason: 'error',
        diagnostic: renderDiagnostic({
          ...facts,
          error: message,
          stage: classified.stage,
          category: classified.category,
          hints: diagnoseFailure({ error: message, stderrTail: facts.stderrTail, mode: host.mode }),
        }),
      }
      settle(failed)
      runs?.finish(id, { status: 'error', stopReason: 'error', error: message, text: '' })
      onChange?.('sync')
      return failed
    },
  )

  // The seam publishes the run before the remote task settles.
  void taskPromise

  return {
    id,
    result,
    dispose() {
      if (disposal !== undefined) return disposal
      request.signal?.removeEventListener?.('abort', onParentAbort)
      controller.abort('subagent disposed')
      control?.release?.(id)
      disposal = taskPromise.then(() => undefined, () => undefined)
      return disposal
    },
  }
}

/**
 * Register one provider per configured host.
 * @param {object} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const overlay = readState()
  const baseConfig = config !== undefined && config !== null && typeof config === 'object' ? config : {}
  // `disabled` is an overlay-only field: it stays on the raw entry and is
  // re-attached after normalization, so the runtime can hide a YAML host without
  // deleting the baseline definition.
  const merged = applyHostOverlay(baseConfig, overlay.hosts)
  const disabledNames = new Set(
    (Array.isArray(merged.hosts) ? merged.hosts : [])
      .filter((entry) => entry !== null && typeof entry === 'object' && entry.disabled === true)
      .map((entry) => entry.name),
  )
  const baseNames = new Set(
    (Array.isArray(baseConfig.hosts) ? baseConfig.hosts : [baseConfig])
      .map((entry) => (entry !== null && typeof entry === 'object' ? entry.name : undefined))
      .filter((name) => typeof name === 'string' && name.length > 0),
  )
  const initialHosts = normalizeHosts(merged).map((host) => ({
    ...host,
    disabled: disabledNames.has(host.name),
    yamlBacked: baseNames.has(host.name),
  }))
  const initialEnabled = initialHosts.filter((host) => host.disabled !== true)
  if (initialEnabled.length === 0) {
    ctx.logger?.warn?.('[dsh-subagent-remote] no enabled hosts configured yet; add one from the plugin page (Plugins -> 远端子智能体)')
  }
  const toolConfig = normalizeToolConfig(baseConfig.tool)
  const overlayCount = overlay.hosts === undefined ? 0 : Object.keys(overlay.hosts).length
  const configDefault = typeof baseConfig.defaultHost === 'string' && baseConfig.defaultHost.length > 0 ? baseConfig.defaultHost : undefined
  if (initialEnabled.length > 0 && configDefault !== undefined && !initialEnabled.some((host) => host.name === configDefault)) {
    throw new Error(`dsh-subagent-remote: defaultHost "${configDefault}" is not an enabled host`)
  }

  // Live registry: the provider `start` closures look hosts up here, so a host
  // field edit takes effect on the next delegation without re-registration.
  // Adding/removing hosts re-registers the corresponding provider effects (the
  // subagent seam is effect-scoped and HMR safe).
  const liveHosts = new Map()
  const providerDisposers = new Map()
  const runtime = {
    selection: undefined,
    toolCtx: null,
    toolDisposer: null,
    autoPrompt: overlay.autoPrompt !== false,
  }
  const runRegistry = createRunRegistry()
  // User-facing Stop handles: keyed by the run id the client already reads from
  // the `runs` RPC payload, released as soon as the activation settles so a
  // stale handle can never abort a later run.
  const runCancels = new Map()
  const runControl = {
    register: (id, cancel) => { runCancels.set(id, cancel) },
    release: (id) => { runCancels.delete(id) },
  }
  // Durable journal: restore previous runs (running -> orphaned), then keep a
  // bounded snapshot in sync. Begin/finish writes are synchronous so a Host
  // crash shortly after dispatch still leaves an orphaned record on restart.
  const recovered = recoverJournal()
  if (recovered.records.length > 0) runRegistry.restore(recovered.records)
  let persistTimer = null
  const persistRunsNow = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    try {
      if (saveJournal(runRegistry.snapshot()) !== true) {
        ctx.logger?.warn?.('[dsh-subagent-remote] run journal write failed')
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-subagent-remote] run journal write threw: ${String(error?.message ?? error)}`)
    }
  }
  const schedulePersist = () => {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistRunsNow()
    }, 1000)
    persistTimer.unref?.()
  }
  const persistRunChange = (mode) => {
    if (mode === 'sync') persistRunsNow()
    else schedulePersist()
  }
  ctx.effect?.(() => () => persistRunsNow(), 'dsh-subagent-remote: run journal')

  /**
   * (Re-)register the model-facing tool so its host enum follows the live hosts.
   * No-op until the tools service is available or when no enabled host exists.
   */
  const syncTool = () => {
    if (toolConfig === undefined || runtime.toolCtx === null) return
    if (runtime.toolDisposer !== null) {
      try { runtime.toolDisposer() } catch { /* already disposed */ }
      runtime.toolDisposer = null
    }
    const enabled = [...liveHosts.values()].filter((host) => host.disabled !== true)
    if (enabled.length === 0) {
      ctx.logger?.info?.('[dsh-subagent-remote] no enabled hosts; model tool not registered yet')
      return
    }
    runtime.toolDisposer = runtime.toolCtx.tools.register(buildUnifiedRemoteTool({
      ctx: runtime.toolCtx,
      hosts: enabled,
      toolConfig,
      resolveHost: (parent) => runtime.selection.resolve(parent),
    }))
    ctx.logger?.info?.(`[dsh-subagent-remote] unified tool "${toolConfig.name ?? 'remote_subagent'}" -> hosts: ${enabled.map((host) => host.name).join(', ')}`)
  }

  const registerHost = (host) => {
    const dispose = ctx.subagents.registerProvider({
      name: host.provider,
      capabilities: CAPABILITIES,
      inheritsParentContext: false,
      start(request) {
        const live = liveHosts.get(host.name)
        if (live === undefined) {
          throw new Error(`dsh-subagent-remote: host "${host.name}" is no longer configured`)
        }
        return startRemoteRun(ctx, live, request, runRegistry, persistRunChange, runControl)
      },
    })
    providerDisposers.set(host.name, { providerName: host.provider, dispose })
  }

  const rebuildSelection = () => {
    runtime.selection = createHostSelection([...liveHosts.values()].filter((host) => host.disabled !== true), {
      configDefault,
      readPersistedDefault: () => readState().defaultHost,
    })
  }

  /** Apply a normalized host list live; returns a change summary. */
  const applyHostList = (nextHosts) => {
    const nextByName = new Map(nextHosts.map((host) => [host.name, host]))
    if (nextByName.size !== nextHosts.length) throw new Error('dsh-subagent-remote: duplicate host names in config')
    const providerNames = new Set()
    for (const host of nextHosts) {
      if (providerNames.has(host.provider)) {
        throw new Error(`dsh-subagent-remote: duplicate provider name "${host.provider}" (hosts must have unique names)`)
      }
      providerNames.add(host.provider)
    }
    const added = []
    const removed = []
    const updated = []
    for (const name of [...liveHosts.keys()]) {
      if (nextByName.has(name)) continue
      const entry = providerDisposers.get(name)
      if (entry !== undefined && typeof entry.dispose === 'function') entry.dispose()
      providerDisposers.delete(name)
      liveHosts.delete(name)
      removed.push(name)
    }
    for (const host of nextHosts) {
      const previous = liveHosts.get(host.name)
      const wasEnabled = previous !== undefined && previous.disabled !== true
      const isEnabled = host.disabled !== true
      if (previous !== undefined) {
        // Only report real changes: an unrelated host must not be labelled
        // "updated" when another host's overlay entry changed.
        if (JSON.stringify(previous) !== JSON.stringify(host)) updated.push(host.name)
      } else {
        added.push(host.name)
      }
      if (isEnabled && !wasEnabled) registerHost(host)
      if (!isEnabled && wasEnabled) {
        const entry = providerDisposers.get(host.name)
        if (entry !== undefined && typeof entry.dispose === 'function') entry.dispose()
        providerDisposers.delete(host.name)
      }
      liveHosts.set(host.name, host)
    }
    rebuildSelection()
    syncTool()
    return { added, removed, updated }
  }

  applyHostList(initialHosts)
  ctx.logger?.info?.(
    `[dsh-subagent-remote] hosts=${initialHosts.length} overlay=${overlayCount} default=${overlay.defaultHost ?? configDefault ?? '(none)'}`,
  )
  for (const host of initialHosts) {
    ctx.logger?.info?.(
      `[dsh-subagent-remote] ${host.disabled === true ? '(disabled) ' : ''}provider "${host.provider}" -> ${host.mode === 'local' ? `local dsh (${host.profile ?? 'acp'})` : `ssh ${host.sshHost}`} cwd=${host.cwd} remoteShell=${host.remoteShell} permission=${host.permission} remoteSession=${host.remoteSession ?? 'close'} scrubEnv=${host.scrubEnv}`,
    )
  }

  // Settings panel RPC (Web/Desktop only; headless and ACP hosts have no connection service).
  ctx.inject(['connection'], (connectionCtx) => {
    const disposer = registerSettingsRpc(connectionCtx, {
      getHosts: () => [...liveHosts.values()],
      buildHosts: (overlayHosts) => {
      const raw = applyHostOverlay(baseConfig, overlayHosts)
      const disabled = new Set(
        (Array.isArray(raw.hosts) ? raw.hosts : [])
          .filter((entry) => entry !== null && typeof entry === 'object' && entry.disabled === true)
          .map((entry) => entry.name),
      )
      return normalizeHosts(raw).map((host) => ({
        ...host,
        disabled: disabled.has(host.name),
        yamlBacked: baseNames.has(host.name),
      }))
    },
      applyHosts: (hosts) => {
        const summary = applyHostList(hosts)
        ctx.logger?.info?.(`[dsh-subagent-remote] hot apply: added=[${summary.added.join(',')}] removed=[${summary.removed.join(',')}] updated=[${summary.updated.join(',')}]`)
        return summary
      },
      configDefault,
      getState: () => readState(),
      setState: (next) => writeState(next),
      setAutoPrompt: (enabled) => { runtime.autoPrompt = enabled },
      getRuns: (sessionId) => runRegistry.list(sessionId),
      cancelRun: (runId) => {
        const cancel = runCancels.get(runId)
        if (typeof cancel !== 'function') return { cancelled: false, reason: 'not-running' }
        cancel()
        return { cancelled: true }
      },
      clearOrphaned: () => {
        const removed = runRegistry.clearOrphaned()
        persistRunChange('sync')
        return removed
      },
    })
    if (typeof disposer === 'function') {
      ctx.logger?.info?.(`[dsh-subagent-remote] settings RPC registered at ${RPC_PATH}`)
    }
  })

  // Every new session should know the capability exists and when to use it,
  // without the user naming the plugin. The callback reads the live host map.
  ctx.inject(['systemPrompt'], (systemPromptCtx) => {
    const toolName = toolConfig === undefined ? 'remote_subagent' : (toolConfig.name ?? 'remote_subagent')
    systemPromptCtx.systemPrompt.section({
      name: 'tool:remote-subagent',
      order: systemPromptCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      text: () => (runtime.autoPrompt ? buildRemoteSubagentSection([...liveHosts.values()], toolName) : ''),
    })
  })

  // Interactive `/remote-host` switcher (Web/Desktop command surface).
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'remote-host',
      description: '查看/切换远端子智能体主机（省略参数列出；reset 清除）',
      input: { hint: '<host|reset>' },
      handler: ({ agent, rawInput }) => {
        const sessionId = agent?.session?.id
        const arg = String(rawInput ?? '').trim()
        const hosts = [...liveHosts.values()]
        try {
          if (arg === '') return { kind: 'success', text: describeHostSwitcher(hosts, runtime.selection, sessionId) }
          if (arg === 'reset') {
            runtime.selection.clear(sessionId)
            return { kind: 'success', text: `已清除本会话的主机选择；当前：${runtime.selection.current(sessionId) ?? '未选择'}` }
          }
          runtime.selection.select(sessionId, arg)
          const host = hosts.find((candidate) => candidate.name === arg)
          return {
            kind: 'success',
            text: `本会话已切换到 ${arg}（${host.mode === 'local' ? 'local' : `ssh:${host.sshHost}`}）`,
          }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      },
    })
  })

  // Optional V2 surface: one model-facing tool with a `host` parameter instead
  // of one official tool row per host. Omitted `host` uses the selection order.
  // The registration is kept in sync with the live host list (empty first-run
  // profiles register the tool lazily once a host is added).
  if (toolConfig !== undefined) {
    ctx.inject(['tools'], (toolCtx) => {
      runtime.toolCtx = toolCtx
      syncTool()
    })
  }
}

