/**
 * Settings surface + JSON overlay for `dsh-subagent-remote`.
 *
 * Two responsibilities:
 *
 * 1. **Overlay configuration** (`~/.dsh/subagent-remote.json`): the profile
 *    patch keeps the baseline host definitions (single source of truth for
 *    credentials-adjacent wiring), while this overlay lets the settings page
 *    override or add hosts without ever editing the profile YAML. It also holds
 *    the persisted default host.
 * 2. **Host RPC** (`/api/dsh-subagent-remote`): the Web/Desktop client panel
 *    talks to this process through the public Host Connection Fetch registry,
 *    following the `@xmanrui/dsh-im` pattern (envelope + content-type checks;
 *    DSH itself applies browser auth and Host/Origin trust before the handler).
 *
 * Edits made through this RPC are applied **hot**: the host calls back into the
 * plugin's live provider registry, which re-registers/removes
 * `ctx.subagents.registerProvider` effects (the seam is effect-scoped by design).
 * Externally edited state files are picked up on the next restart; the payload
 * marks those hosts with `pendingRestart` so the page can say so.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const RPC_ENDPOINT = 'dsh-subagent-remote'
export const RPC_PATH = `/api/${RPC_ENDPOINT}`
export const SETTINGS_ORDER = 22

/** Host fields the overlay is allowed to override. */
export const OVERLAY_HOST_FIELDS = Object.freeze([
  'ssh',
  'cwd',
  'permission',
  'remoteSession',
  'scrubEnv',
  'expectAgentName',
  'timeoutMs',
  'disabled',
])

/**
 * Resolve the state file path (`$DSH_HOME/subagent-remote.json`).
 * @returns {string}
 */
export function statePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'subagent-remote.json')
}

/**
 * Read the persisted overlay/state; missing or corrupt files yield `{}`.
 * @param {string} [file]
 * @returns {{defaultHost?: string, hosts?: Record<string, object>, updatedAt?: string}}
 */
export function readState(file = statePath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state = {}
    if (typeof parsed.defaultHost === 'string' && parsed.defaultHost.length > 0) state.defaultHost = parsed.defaultHost
    if (parsed.hosts !== null && typeof parsed.hosts === 'object' && !Array.isArray(parsed.hosts)) {
      state.hosts = parsed.hosts
    }
    if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt
    return state
  } catch {
    return {}
  }
}

/**
 * Atomically persist the state (temp sibling + rename), keeping a mode that the
 * current user can read.
 * @param {object} next full state object
 * @param {string} [file]
 * @returns {object} the persisted state
 */
export function writeState(next, file = statePath()) {
  const payload = { ...next, updatedAt: new Date().toISOString() }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
  return payload
}

/**
 * Apply the overlay onto the raw plugin config before normalization.
 *
 * - An overlay entry whose `name` matches a configured host is a **shallow
 *   override** of the allowed fields.
 * - An overlay entry with a new name is **appended** as a new host; it must
 *   carry `ssh` (or `local: true`) and an absolute `cwd`, exactly like a
 *   profile-declared host.
 *
 * Pure function: never touches the filesystem.
 *
 * @param {object|undefined} config raw plugin config
 * @param {Record<string, object>|undefined} overlayHosts state.hosts
 * @returns {object} a new raw config with overlay entries applied
 */
export function applyHostOverlay(config, overlayHosts) {
  const base = config !== undefined && config !== null && typeof config === 'object' ? config : {}
  // An empty config ({}) is a bundle install with no hosts yet, not a single
  // anonymous host; only an actual single-host object gets wrapped.
  const singleHost = base.ssh !== undefined || base.local === true || base.cwd !== undefined
  const entries = Array.isArray(base.hosts)
    ? base.hosts.map((entry) => ({ ...entry }))
    : (singleHost ? [{ ...base }] : [])
  const overrides = overlayHosts !== undefined && overlayHosts !== null && typeof overlayHosts === 'object' && !Array.isArray(overlayHosts)
    ? overlayHosts
    : {}
  for (const [name, patch] of Object.entries(overrides)) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue
    const index = entries.findIndex((entry) => entry?.name === name)
    const allowed = {}
    for (const field of OVERLAY_HOST_FIELDS) {
      if (patch[field] !== undefined) allowed[field] = patch[field]
    }
    if (index >= 0) entries[index] = { ...entries[index], ...allowed }
    else entries.push({ name, ...allowed })
  }
  return { ...base, hosts: entries }
}

/**
 * Validate one overlay host patch; throws with a user-facing message.
 * @param {unknown} patch candidate overlay entry
 * @returns {object} the sanitized patch (only allowed fields)
 */
export function sanitizeOverlayHostPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('host patch must be an object')
  }
  const clean = {}
  for (const field of OVERLAY_HOST_FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    switch (field) {
      case 'ssh':
        if (typeof value !== 'string' || value.trim().length === 0) throw new Error('ssh must be a non-empty string')
        if (/^[-\s]/.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) {
          throw new Error('ssh must not start with a dash or contain whitespace/control characters')
        }
        clean[field] = value.trim()
        break
      case 'expectAgentName':
        if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`)
        clean[field] = value.trim()
        break
      case 'cwd':
        if (typeof value !== 'string' || !(value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))) {
          throw new Error('cwd must be an absolute path')
        }
        clean[field] = value
        break
      case 'permission':
        if (!['read-only', 'ask', 'deny', 'auto'].includes(value)) throw new Error('permission must be read-only|ask|deny|auto')
        clean[field] = value
        break
      case 'remoteSession':
        if (value !== 'close' && value !== 'keep') throw new Error('remoteSession must be close|keep')
        clean[field] = value
        break
      case 'scrubEnv':
        if (typeof value !== 'boolean') throw new Error('scrubEnv must be a boolean')
        clean[field] = value
        break
      case 'timeoutMs':
        if (!(Number.isFinite(value) && value > 0)) throw new Error('timeoutMs must be a positive number')
        clean[field] = value
        break
      case 'disabled':
        if (typeof value !== 'boolean') throw new Error('disabled must be a boolean')
        clean[field] = value
        break
      /* v8 ignore next 2 -- field list and switch are maintained together. */
      default:
        break
    }
  }
  if (Object.keys(clean).length === 0) throw new Error('host patch changed nothing')
  return clean
}

/**
 * Project one live host through its overlay patch (what the page shows).
 * @param {object} host normalized live host
 * @param {object} [overlay] overlay entry for this host
 * @returns {{endpoint: string, cwd: string, permission: string, remoteSession: string, envScrubbed: boolean, expectedAgent: string|null}}
 */
export function projectHost(host, overlay) {
  const effective = overlay === undefined || overlay === null ? {} : overlay
  return {
    endpoint: host.mode === 'local'
      ? `local:${host.profile ?? 'acp'}`
      : `ssh:${effective.ssh ?? host.sshHost}`,
    cwd: effective.cwd ?? host.cwd,
    permission: effective.permission ?? host.permission,
    remoteSession: effective.remoteSession ?? host.remoteSession ?? 'close',
    envScrubbed: (effective.scrubEnv ?? host.scrubEnv) === true,
    expectedAgent: effective.expectAgentName ?? host.expectAgentName ?? null,
    disabled: (effective.disabled ?? host.disabled) === true,
  }
}

/**
 * View of one live host without the overlay, used to detect pending (unapplied)
 * external edits.
 * @param {object} host normalized live host
 * @returns {object}
 */
function liveHostView(host) {
  return projectHost(host, undefined)
}

/**
 * Whether one live host is enabled (runtime providers only exist for enabled hosts).
 * @param {object} host normalized host
 * @returns {boolean}
 */
export function hostEnabled(host) {
  return host !== undefined && host !== null && host.disabled !== true
}

/**
 * Build the payload the settings page renders.
 * @param {object[]} hosts normalized **live** hosts (runtime registry source)
 * @param {object} state persisted overlay/state
 * @param {string|undefined} configDefault default host from the plugin config
 * @returns {object}
 */
export function buildStatePayload(hosts, state, configDefault) {
  const persistedDefault = state.defaultHost
  const defaultHost = persistedDefault ?? configDefault
  const defaultSource = persistedDefault !== undefined ? 'settings' : (configDefault !== undefined ? 'config' : 'none')
  const rows = hosts.map((host) => {
    const overlayEntry = state.hosts?.[host.name]
    const projected = projectHost(host, overlayEntry)
    const live = liveHostView(host)
    return {
      name: host.name,
      provider: host.provider,
      mode: host.mode,
      ...projected,
      live,
      pendingRestart: JSON.stringify(projected) !== JSON.stringify(live),
      fromOverlay: overlayEntry !== undefined,
      yamlBacked: host.yamlBacked !== false,
      overlay: overlayEntry === undefined ? null : overlayEntry,
    }
  })
  return {
    defaultHost,
    defaultSource,
    stateFile: statePath(),
    hotReload: true,
    pendingHostEdits: rows.filter((row) => row.pendingRestart).map((row) => row.name),
    hosts: rows,
  }
}

/**
 * Validate one client RPC envelope.
 * @param {unknown} message parsed JSON body
 * @returns {{ok: true, rpcId: string, method: string, payload: object}|{ok: false, reason: string}}
 */
export function parseRpcRequest(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return { ok: false, reason: 'body must be an object' }
  if (message.type !== 'client-request') return { ok: false, reason: 'type must be client-request' }
  if (typeof message.rpcId !== 'string' || message.rpcId.length === 0) return { ok: false, reason: 'rpcId must be a non-empty string' }
  if (message.method !== RPC_ENDPOINT && message.method !== RPC_PATH) return { ok: false, reason: 'method must name this RPC endpoint' }
  const call = message.payload
  if (call === null || typeof call !== 'object' || Array.isArray(call)) return { ok: false, reason: 'payload must be an object' }
  if (typeof call.method !== 'string') return { ok: false, reason: 'payload.method must be a string' }
  const payload = call.payload === undefined ? {} : call.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'payload.payload must be an object' }
  return { ok: true, rpcId: message.rpcId, method: call.method, payload }
}

/**
 * Run a cheap reachability probe for one host.
 * @param {object} host normalized host descriptor
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, detail: string, durationMs: number}>}
 */
export async function probeHost(host, timeoutMs = 25000, attempts = 2) {
  const started = Date.now()
  if (host.mode === 'local') {
    return { ok: true, detail: `local peer (${host.profile ?? 'acp'}), no probe needed`, durationMs: 0 }
  }
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await runProbeOnce(host, timeoutMs)
    if (last.ok || attempt === attempts) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { ok: last.ok, detail: last.detail, durationMs: Date.now() - started, attempts }
}

/**
 * One SSH reachability attempt.
 *
 * Uses `spawn` with `stdin: 'ignore'` on purpose: `execFile` pipes stdin, and a
 * leftover stdin pipe can make ssh hang on some Windows setups. The local ssh
 * handshake is also occasionally slow (>8 s) on congested networks, hence a
 * generous timeout and one retry in {@link probeHost}.
 *
 * @param {object} host normalized host
 * @param {number} timeoutMs per-attempt timeout
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function runProbeOnce(host, timeoutMs) {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=5',
    ...(host.sshArgs || []),
    host.sshHost,
    '--',
    'echo ok',
  ]
  return new Promise((resolve) => {
    const child = spawn(host.sshBin || 'ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, detail: `probe timed out after ${timeoutMs}ms (slow SSH handshake or network)` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      finish({ ok: false, detail: `could not start ssh: ${String(error?.message ?? error)}` })
    })
    child.on('close', (code) => {
      const ok = code === 0 && stdout.trim().endsWith('ok')
      finish({
        ok,
        detail: ok ? 'ssh reachable' : (`ssh exited ${code}: ${(stderr.trim() || stdout.trim() || 'no output').slice(0, 300)}`),
      })
    })
  })
}

/**
 * Register the settings RPC on the Host Connection Fetch registry.
 *
 * The plugin supplies the live host registry hooks, so a successful write can be
 * applied immediately (hot reload) instead of telling the user to restart.
 *
 * @param {object} ctx Cordis host context (has `connection`)
 * @param {object} parts
 * @param {() => object[]} parts.getHosts current normalized live hosts
 * @param {(overlayHosts: Record<string, object>) => object[]} parts.buildHosts normalize a candidate overlay
 * @param {(hosts: object[]) => {added: string[], removed: string[], updated: string[]}} parts.applyHosts apply a normalized host list live
 * @param {() => object} parts.getState persisted overlay/state
 * @param {(next: object) => object} parts.setState persist a full state object
 * @param {string|undefined} parts.configDefault default host from the plugin config
 * @returns {(() => void)|undefined} disposer when registered
 */
export function registerSettingsRpc(ctx, parts) {
  const registry = ctx?.connection?.fetch
  if (registry === undefined || typeof registry.register !== 'function') return undefined
  return registry.register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const parsed = parseRpcRequest(message)
      if (parsed.ok === false) {
        return Response.json({ type: 'server-response', rpcId: 'invalid-request', result: { ok: false, error: { code: 'gateway/bad-request', message: parsed.reason, details: {} } } })
      }
      const reply = (result) => Response.json({ type: 'server-response', rpcId: parsed.rpcId, result })
      const badRequest = (messageText) => reply({ ok: false, error: { code: 'bad-request', message: messageText, details: {} } })
      const state = () => parts.getState()
      const hosts = () => parts.getHosts()
      const payloadState = () => buildStatePayload(hosts(), state(), parts.configDefault)
      try {
        switch (parsed.method) {
          case 'state':
            return reply({ ok: true, value: payloadState() })
          case 'setDefaultHost': {
            const name = typeof parsed.payload.name === 'string' ? parsed.payload.name : undefined
            if (name !== undefined && hosts().every((host) => host.name !== name)) {
              return badRequest(`unknown host "${name}"`)
            }
            const next = { ...state() }
            if (name === undefined) delete next.defaultHost
            else next.defaultHost = name
            parts.setState(next)
            return reply({ ok: true, value: payloadState() })
          }
          case 'setHost': {
            const name = typeof parsed.payload.name === 'string' ? parsed.payload.name.trim() : ''
            if (name.length === 0) return badRequest('name is required')
            let patch
            try {
              patch = sanitizeOverlayHostPatch(parsed.payload.patch)
            } catch (error) {
              return badRequest(String(error?.message ?? error))
            }
            const current = state()
            const next = { ...current, hosts: { ...(current.hosts ?? {}) } }
            const mergedEntry = { ...(next.hosts[name] ?? {}), ...patch }
            // Enabling a host that had no other overrides leaves no meaningful
            // entry: drop it so the card stops showing a "覆盖层" badge.
            const meaningful = Object.keys(mergedEntry).filter((field) => !(field === 'disabled' && mergedEntry[field] === false))
            if (meaningful.length === 0) delete next.hosts[name]
            else if (patch.disabled === false) {
              const { disabled: _ignored, ...rest } = mergedEntry
              next.hosts[name] = rest
            } else next.hosts[name] = mergedEntry
            let normalized
            try {
              normalized = parts.buildHosts(next.hosts)
            } catch (error) {
              return badRequest(`invalid host config: ${String(error?.message ?? error)}`)
            }
            // A disabled host must not stay the persisted default.
            if (next.defaultHost !== undefined && normalized.some((host) => host.name === next.defaultHost && host.disabled === true)) {
              delete next.defaultHost
            }
            parts.setState(next)
            const apply = parts.applyHosts(normalized)
            return reply({ ok: true, value: { ...payloadState(), apply } })
          }
          case 'resetHost': {
            const name = typeof parsed.payload.name === 'string' ? parsed.payload.name : ''
            const current = state()
            const next = { ...current, hosts: { ...(current.hosts ?? {}) } }
            delete next.hosts[name]
            let normalized
            try {
              normalized = parts.buildHosts(next.hosts)
            } catch (error) {
              return badRequest(`invalid host config: ${String(error?.message ?? error)}`)
            }
            // A removed host must not stay the persisted default either.
            if (next.defaultHost !== undefined && normalized.every((host) => host.name !== next.defaultHost || host.disabled === true)) {
              delete next.defaultHost
            }
            parts.setState(next)
            const apply = parts.applyHosts(normalized)
            return reply({ ok: true, value: { ...payloadState(), apply } })
          }
          case 'probe': {
            const name = typeof parsed.payload.name === 'string' ? parsed.payload.name : undefined
            const host = hosts().find((candidate) => candidate.name === name)
            if (host === undefined) return badRequest(`unknown host "${String(name)}"`)
            return reply({ ok: true, value: await probeHost(host) })
          }
          default:
            return badRequest(`unknown method "${parsed.method}"`)
        }
      } catch (error) {
        return reply({ ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: {} } })
      }
    },
  })
}



