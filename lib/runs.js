/**
 * In-memory registry of remote subagent runs, used by the session-header
 * indicator (and the settings RPC `runs` method).
 *
 * The registry is deliberately tiny and dependency-free: one record per run,
 * finished records kept for a bounded grace period so the header can show the
 * result/duration after the run settles. Records are per-process only; a DSH
 * restart drops them (the conversation still has the normal completion notice).
 */

/** How long a settled run stays visible in the header (ms). */
export const DEFAULT_RUN_KEEP_MS = 10 * 60 * 1000

/** Hard cap on retained records, so a long-lived host cannot grow unbounded. */
export const MAX_RUN_RECORDS = 64

const PREVIEW_MAX = 240

/**
 * Strip control characters and cap one text preview for the UI.
 * @param {unknown} text
 * @returns {string}
 */
export function previewText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return clean.length <= PREVIEW_MAX ? clean : `${clean.slice(0, PREVIEW_MAX - 1)}…`
}

/**
 * Public record shape returned to the client (never expose internal maps).
 * @param {object} record
 * @returns {object}
 */
function publicRecord(record) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    host: record.host,
    provider: record.provider,
    endpoint: record.endpoint,
    cwd: record.cwd,
    permission: record.permission,
    remoteSession: record.remoteSession,
    status: record.status,
    phase: record.phase,
    toolCalls: record.toolCalls,
    lastTool: record.lastTool,
    lastToolStatus: record.lastToolStatus,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    stopReason: record.stopReason,
    error: record.error,
    textPreview: record.textPreview,
    remoteSessionId: record.remoteSessionId,
    usage: record.usage,
  }
}

/**
 * Create one registry instance (one per mounted plugin instance).
 * @param {{keepMs?: number, max?: number, now?: () => number}} [options]
 */
export function createRunRegistry(options = {}) {
  const keepMs = Number.isFinite(options.keepMs) && options.keepMs >= 0 ? options.keepMs : DEFAULT_RUN_KEEP_MS
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : MAX_RUN_RECORDS
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const records = new Map()

  const prune = () => {
    const now = clock()
    for (const [id, record] of records) {
      if (record.finishedAt !== null && now - record.finishedAt > keepMs) records.delete(id)
    }
    while (records.size > max) {
      // Drop the oldest settled record first; running records must stay visible.
      let oldestId
      let oldestAt = Infinity
      for (const [id, record] of records) {
        if (record.finishedAt === null) continue
        if (record.finishedAt < oldestAt) {
          oldestAt = record.finishedAt
          oldestId = id
        }
      }
      if (oldestId === undefined) break
      records.delete(oldestId)
    }
  }

  /**
   * Start tracking one delegation.
   * @param {object} input
   * @returns {object} internal record (treat as read-only outside this module)
   */
  const begin = (input) => {
    prune()
    const record = {
      id: String(input.id),
      sessionId: typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : null,
      host: String(input.host ?? 'remote'),
      provider: String(input.provider ?? ''),
      endpoint: String(input.endpoint ?? ''),
      cwd: String(input.cwd ?? ''),
      permission: String(input.permission ?? ''),
      remoteSession: String(input.remoteSession ?? 'close'),
      status: 'running',
      phase: 'starting',
      toolCalls: 0,
      lastTool: null,
      lastToolId: null,
      lastToolStatus: null,
      startedAt: clock(),
      finishedAt: null,
      durationMs: null,
      stopReason: null,
      error: null,
      textPreview: '',
      remoteSessionId: null,
      usage: null,
    }
    records.set(record.id, record)
    return record
  }

  /**
   * Apply one generic patch (phase transitions etc.).
   * @param {string} id
   * @param {object} patch
   */
  const update = (id, patch) => {
    const record = records.get(String(id))
    if (record === undefined || patch === null || typeof patch !== 'object') return
    Object.assign(record, patch)
  }

  /**
   * Fold one ACP session/update into the record.
   * @param {string} id
   * @param {string} kind
   * @param {object} updatePayload
   */
  const progress = (id, kind, updatePayload) => {
    const record = records.get(String(id))
    if (record === undefined || record.finishedAt !== null) return
    const payload = updatePayload !== null && typeof updatePayload === 'object' ? updatePayload : {}
    if (kind === 'tool_call') {
      record.phase = 'running'
      record.toolCalls += 1
      record.lastTool = typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : 'tool'
      record.lastToolId = payload.toolCallId ?? null
      record.lastToolStatus = typeof payload.status === 'string' ? payload.status : 'running'
      return
    }
    if (kind === 'tool_call_update') {
      if (record.lastToolId !== null && payload.toolCallId === record.lastToolId) {
        if (typeof payload.status === 'string') record.lastToolStatus = payload.status
        if (typeof payload.title === 'string' && payload.title.length > 0) record.lastTool = payload.title
      }
      return
    }
    if (kind === 'agent_message_chunk') {
      record.phase = 'replying'
      return
    }
    if (kind === 'usage_update') {
      record.usage = { used: payload.used ?? null, size: payload.size ?? null }
    }
  }

  /**
   * Settle one run and retain it for the grace period.
   * @param {string} id
   * @param {object} patch
   */
  const finish = (id, patch = {}) => {
    const record = records.get(String(id))
    if (record === undefined) return
    const now = clock()
    record.finishedAt = now
    record.durationMs = Number.isFinite(patch.durationMs) ? patch.durationMs : now - record.startedAt
    record.stopReason = typeof patch.stopReason === 'string' ? patch.stopReason : record.stopReason
    record.status = typeof patch.status === 'string'
      ? patch.status
      : (record.stopReason === 'completed' ? 'completed' : record.stopReason === 'aborted' ? 'aborted' : 'error')
    record.phase = record.status
    record.error = typeof patch.error === 'string' ? patch.error : null
    record.textPreview = previewText(patch.text)
    record.remoteSessionId = typeof patch.remoteSessionId === 'string' ? patch.remoteSessionId : record.remoteSessionId
    record.usage = patch.usage !== undefined ? patch.usage : record.usage
    if (Number.isFinite(patch.toolCalls)) record.toolCalls = patch.toolCalls
    if (typeof patch.lastTool === 'string' && patch.lastTool.length > 0) record.lastTool = patch.lastTool
    prune()
  }

  /**
   * List records for one session (undefined = all sessions, for diagnostics/tests).
   * Running records first, then newest settled first.
   * @param {string|undefined} sessionId
   * @returns {object[]}
   */
  const list = (sessionId) => {
    prune()
    const selected = []
    for (const record of records.values()) {
      if (typeof sessionId === 'string' && sessionId.length > 0 && record.sessionId !== sessionId) continue
      selected.push(record)
    }
    selected.sort((left, right) => {
      const leftRunning = left.status === 'running' ? 1 : 0
      const rightRunning = right.status === 'running' ? 1 : 0
      if (leftRunning !== rightRunning) return rightRunning - leftRunning
      return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    })
    return selected.map(publicRecord)
  }

  return { begin, update, progress, finish, list, prune, keepMs, max }
}
