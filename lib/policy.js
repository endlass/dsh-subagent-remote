/**
 * Permission policy for remote subagent runs.
 *
 * ACP asks the client to answer `session/request_permission` for a remote tool
 * call. DSH's ACP server only correlates the request with a `toolCallId`; it does
 * NOT send the tool name or arguments in the permission params. The only way to
 * judge risk is to look up the preceding `session/update -> tool_call` frame and
 * inspect its `title` (DSH tool name) plus `rawInput` (model arguments).
 *
 * Four configured modes (default `read-only`):
 *   - read-only: allow read-only tool calls, reject everything else.
 *   - ask:       allow read-only; route write/execute to the LOCAL approval seam
 *                (`ctx.approval.request`) and fail closed when nobody answers.
 *   - deny:      reject every request.
 *   - auto:      allow every request (explicitly opt-in; risky).
 *
 * The policy never widens itself because the remote keeps asking: a denied call
 * stays denied for the rest of the run.
 */

/** DSH tool names that only read local state. */
export const READ_ONLY_TOOL_NAMES = new Set([
  'read', 'read_image', 'glob', 'grep', 'ls', 'list', 'list_dir', 'list_directory',
  'search', 'search_files', 'find', 'stat', 'file', 'head', 'tail', 'wc', 'pwd',
  'df', 'du', 'uname', 'hostname', 'whoami', 'id', 'env', 'printenv', 'date',
  'uptime', 'ps', 'free', 'which', 'where', 'tree', 'todo_write', 'todo_read',
  'ask_user', 'skill', 'present', 'web_search', 'web_fetch', 'working_directory',
  'session_query', 'job_list', 'job_output', 'list_agents', 'get_goal',
  'ask_user_question', 'document_search_probe',
])

/** Tools whose name is inherently read-only even with a path argument. */
const WRITE_HINTS = /(^|_)(write|edit|create|delete|remove|move|rename|mkdir|copy|chmod|chown|append|patch|install|upgrade|kill|stop|start|restart|run|exec|execute|bash|shell|terminal|commit|push|publish|deploy|apply)($|_)/i
const SHELL_WRITE_HINTS = /(^|[\s;&|])(rm|mv|cp|dd|mkfs|truncate|tee|sed\s+-i|git\s+(commit|push|reset|checkout)|npm\s+(install|publish)|pip\s+install|systemctl\s+(start|stop|restart)|kill|pkill|shutdown|reboot)\b/i

/**
 * Classify one remote tool call as `read-only`, `write`, or `unknown`.
 * @param {{title?: string, kind?: string, rawInput?: unknown}|undefined} call
 * @returns {'read-only'|'write'|'unknown'}
 */
export function classifyToolCall(call) {
  if (call === undefined || call === null) return 'unknown'
  const title = String(call.title ?? '').trim()
  const lower = title.toLowerCase()
  const raw = typeof call.rawInput === 'string' ? call.rawInput : JSON.stringify(call.rawInput ?? '')

  if (READ_ONLY_TOOL_NAMES.has(lower)) return 'read-only'
  if (WRITE_HINTS.test(lower)) return 'write'
  // A shell/terminal/bash call is writable unless its command text is clearly read-only.
  if (/(bash|pwsh|powershell|shell|terminal|exec|subprocess|run_command)/i.test(lower)) {
    return SHELL_WRITE_HINTS.test(raw) ? 'write' : 'read-only'
  }
  // DSH's ACP `kind` is always "other"; kept for future protocol improvements.
  if (call.kind === 'read') return 'read-only'
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') return 'write'
  return 'unknown'
}

/**
 * Pick the concrete ACP option to answer with.
 * @param {Array<{optionId?: string, kind?: string}>} options
 * @param {boolean} allow
 * @returns {{optionId?: string, kind?: string}|undefined}
 */
export function pickOption(options, allow) {
  const list = Array.isArray(options) ? options : []
  const wantKinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of wantKinds) {
    const hit = list.find((option) => option?.kind === kind)
    if (hit !== undefined) return hit
  }
  const wantIds = allow ? ['allow-once', 'allow-always'] : ['reject-once', 'reject-always']
  for (const id of wantIds) {
    const hit = list.find((option) => option?.optionId === id)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Build the `decide` callback used by the ACP transport.
 *
 * @param {object} parts
 * @param {'read-only'|'ask'|'deny'|'auto'} parts.mode
 * @param {object|undefined} parts.request provider `start(request)` object (has `.parent`)
 * @param {object} parts.ctx Cordis context of the plugin
 * @param {string} parts.providerName
 * @param {{granted: boolean, reason: string}|undefined} [parts.preAuth]
 *   Run-scoped authorization captured while the delegating turn was still open.
 *   The approval seam is turn-enclosed, but a remote run outlives the parent
 *   turn, so `ask` must decide its write policy at dispatch time and reuse it.
 * @returns {(input: {call?: object, options?: object[], toolCallId?: string}) => Promise<{allow: boolean, reason: string, source: string}>}
 */
export function createPermissionDecider(parts) {
  const { mode, request, ctx, providerName, preAuth } = parts
  if (!['read-only', 'ask', 'deny', 'auto'].includes(mode)) {
    throw new Error(`unknown permission mode: ${mode}`)
  }

  return async function decide(input) {
    const kind = classifyToolCall(input.call)
    const toolName = input.call?.title !== undefined ? String(input.call.title) : '(unknown tool)'

    if (mode === 'auto') {
      return { allow: true, reason: `auto mode allows ${toolName}`, source: 'auto' }
    }
    if (mode === 'deny') {
      return { allow: false, reason: `deny mode rejects ${toolName}`, source: 'deny' }
    }
    if (kind === 'read-only') {
      return { allow: true, reason: `read-only tool ${toolName}`, source: 'read-only-allow' }
    }
    if (mode === 'read-only') {
      return {
        allow: false,
        reason: `read-only mode rejects ${kind} tool ${toolName}`,
        source: 'read-only-reject',
      }
    }

    // mode === 'ask': use the run-scoped authorization captured in-turn, and
    // fail closed when it was not granted.
    if (preAuth !== undefined && preAuth.granted === true) {
      return { allow: true, reason: `run pre-authorized: ${preAuth.reason}`, source: 'ask-preauth' }
    }
    return {
      allow: false,
      reason: `not pre-authorized (${preAuth?.reason ?? 'no in-turn approval'}); risky tool ${toolName} stays denied`,
      source: 'ask-not-granted',
    }
  }
}

/**
 * Ask the deployment's approval seam once per run, while the delegating turn is
 * still open. `approval.request()` is turn-enclosed (DSH 0.2.1-rc.2), so this is
 * the only moment a remote subagent can get a human/machine decision: its
 * permission prompts arrive after the parent turn has ended.
 *
 * @param {object} parts
 * @param {object} parts.ctx
 * @param {object} parts.request provider request with `.parent`
 * @param {string} parts.providerName
 * @param {string} parts.endpoint human-readable target
 * @returns {Promise<{granted: boolean, reason: string, outcome?: string}>}
 */
export async function requestRunPreAuthorization(parts) {
  const { ctx, request, providerName, endpoint } = parts
  const approval = ctx.get?.('approval')
  if (approval === undefined || typeof approval.request !== 'function') {
    return { granted: false, reason: 'no local approval service', outcome: 'unavailable' }
  }
  try {
    const outcome = await approval.request({
      agent: request.parent,
      toolName: `${providerName}:run`,
      reason: `allow this one remote subagent run on ${endpoint} to execute write/execute tools if the task needs them?`,
    })
    return {
      granted: outcome === 'allowed-once',
      reason: `in-turn approval outcome: ${outcome}`,
      outcome,
    }
  } catch (error) {
    return {
      granted: false,
      reason: `in-turn approval failed: ${String(error?.message ?? error)}`,
      outcome: 'error',
    }
  }
}

