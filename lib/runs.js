/**
 * In-memory registry of remote subagent runs, used by the session-header
 * indicator (and the settings RPC `runs` method).
 *
 * The registry is deliberately tiny and dependency-free: one record per run,
 * finished records kept for a bounded grace period so the header can show the
 * result/duration after the run settles. lib/journal.js persists a bounded
 * snapshot so a Host restart can surface previously-running runs as orphaned;
 * the registry itself stays purely in-memory.
 */

/** How long a settled run stays visible in the header (ms). */
export const DEFAULT_RUN_KEEP_MS = 10 * 60 * 1000

/** How long an orphaned (Host restarted mid-run) record stays visible (ms). */
export const DEFAULT_ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000

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
    orphanedAt: record.orphanedAt,
  }
}

/**
 * Create one registry instance (one per mounted plugin instance).
 * @param {{keepMs?: number, orphanKeepMs?: number, max?: number, now?: () => number}} [options]
 */
export function createRunRegistry(options = {}) {
  const keepMs = Number.isFinite(options.keepMs) && options.keepMs >= 0 ? options.keepMs : DEFAULT_RUN_KEEP_MS
  const orphanKeepMs = Number.isFinite(options.orphanKeepMs) && options.orphanKeepMs >= 0
    ? options.orphanKeepMs
    : DEFAULT_ORPHAN_KEEP_MS
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : MAX_RUN_RECORDS
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const records = new Map()

  const prune = () => {
    const now = clock()
    for (const [id, record] of records) {
      const effectiveKeep = record.status === 'orphaned' ? orphanKeepMs : keepMs
      if (record.finishedAt !== null && now - record.finishedAt > effectiveKeep) records.delete(id)
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
      orphanedAt: null,
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
   * Restore records from the durable journal (called once at plugin apply).
   * Invalid/duplicate ids are skipped; no record is ever overwritten.
   * @param {object[]} entries
   * @returns {number} number of restored records
   */
  const restore = (entries) => {
    if (!Array.isArray(entries)) return 0
    let restored = 0
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue
      if (records.has(entry.id)) continue
      const status = typeof entry.status === 'string' && entry.status.length > 0 ? entry.status : 'error'
      records.set(entry.id, {
        id: entry.id,
        sessionId: typeof entry.sessionId === 'string' && entry.sessionId.length > 0 ? entry.sessionId : null,
        host: typeof entry.host === 'string' && entry.host.length > 0 ? entry.host : 'remote',
        provider: typeof entry.provider === 'string' ? entry.provider : '',
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        permission: typeof entry.permission === 'string' ? entry.permission : '',
        remoteSession: typeof entry.remoteSession === 'string' ? entry.remoteSession : 'close',
        status,
        phase: typeof entry.phase === 'string' && entry.phase.length > 0 ? entry.phase : status,
        toolCalls: Number.isFinite(entry.toolCalls) ? entry.toolCalls : 0,
        lastTool: typeof entry.lastTool === 'string' ? entry.lastTool : null,
        lastToolId: null,
        lastToolStatus: typeof entry.lastToolStatus === 'string' ? entry.lastToolStatus : null,
        startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : clock(),
        finishedAt: Number.isFinite(entry.finishedAt) ? entry.finishedAt : null,
        durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
        stopReason: typeof entry.stopReason === 'string' ? entry.stopReason : null,
        error: typeof entry.error === 'string' ? entry.error : null,
        textPreview: typeof entry.textPreview === 'string' ? entry.textPreview : '',
        remoteSessionId: typeof entry.remoteSessionId === 'string' ? entry.remoteSessionId : null,
        usage: entry.usage !== undefined ? entry.usage : null,
        orphanedAt: Number.isFinite(entry.orphanedAt) ? entry.orphanedAt : null,
      })
      restored += 1
    }
    prune()
    return restored
  }

  /**
   * Serializable snapshot for the journal.
   * @returns {object[]}
   */
  const snapshot = () => [...records.values()].map((record) => ({
    ...record,
    usage: record.usage !== null && typeof record.usage === 'object' ? { ...record.usage } : null,
  }))

  /**
   * Remove all orphaned records (user reconciliation action).
   * @returns {number} removed count
   */
  const clearOrphaned = () => {
    let removed = 0
    for (const [id, record] of records) {
      if (record.status === 'orphaned') {
        records.delete(id)
        removed += 1
      }
    }
    return removed
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

  return { begin, update, progress, finish, restore, snapshot, clearOrphaned, list, prune, keepMs, orphanKeepMs, max }
}
