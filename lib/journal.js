/**
 * Durable run journal for the remote-subagent plugin.
 *
 * The in-memory registry in lib/runs.js is enough for the session header while
 * the Host is alive. This module persists a bounded snapshot to
 * `$DSH_HOME/storages/dsh-subagent-remote/runs.json` so a Host restart does not
 * erase the fact that a remote delegation was dispatched.
 *
 * On startup, records that were still `running` are marked **orphaned** (not
 * failed): the remote machine may have completed the work before the local Host
 * died, and the plugin has no way to know. The UI surfaces them for manual
 * reconciliation instead of silently dropping them.
 *
 * Atomic write (temp sibling + rename); a corrupt/missing journal is treated as
 * empty. No locking: this is a single-Host desktop plugin.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const JOURNAL_VERSION = 1

/**
 * Resolve the journal path (or an explicit override).
 * @param {string} [file]
 * @returns {string}
 */
export function journalPath(file) {
  if (typeof file === 'string' && file.length > 0) return file
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-subagent-remote', 'runs.json')
}

/**
 * Read persisted records; missing/corrupt files yield an empty array.
 * @param {string} [file]
 * @returns {object[]}
 */
export function loadJournal(file = journalPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    if (parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed.runs)) return []
    return parsed.runs.filter((record) => record !== null && typeof record === 'object' && typeof record.id === 'string')
  } catch {
    return []
  }
}

/**
 * Persist a bounded snapshot atomically.
 * @param {object[]} records internal registry records
 * @param {string} [file]
 * @returns {boolean} whether the write succeeded
 */
export function saveJournal(records, file = journalPath()) {
  if (!Array.isArray(records)) return false
  const payload = {
    version: JOURNAL_VERSION,
    updatedAt: new Date().toISOString(),
    runs: records.map((record) => ({
      id: record.id,
      sessionId: record.sessionId ?? null,
      host: record.host ?? 'remote',
      provider: record.provider ?? '',
      endpoint: record.endpoint ?? '',
      cwd: record.cwd ?? '',
      permission: record.permission ?? '',
      remoteSession: record.remoteSession ?? 'close',
      status: record.status ?? 'error',
      phase: record.phase ?? record.status ?? 'error',
      toolCalls: Number.isFinite(record.toolCalls) ? record.toolCalls : 0,
      lastTool: record.lastTool ?? null,
      lastToolStatus: record.lastToolStatus ?? null,
      startedAt: Number.isFinite(record.startedAt) ? record.startedAt : Date.now(),
      finishedAt: Number.isFinite(record.finishedAt) ? record.finishedAt : null,
      durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
      stopReason: record.stopReason ?? null,
      error: typeof record.error === 'string' ? record.error : null,
      textPreview: typeof record.textPreview === 'string' ? record.textPreview : '',
      remoteSessionId: record.remoteSessionId ?? null,
      usage: record.usage ?? null,
      orphanedAt: Number.isFinite(record.orphanedAt) ? record.orphanedAt : null,
    })),
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    return true
  } catch {
    return false
  }
}

/**
 * Mark previously-running records as orphaned (Host restart / crash recovery).
 * Does not touch records that already finished or were already orphaned.
 * @param {object[]} records loaded journal records
 * @param {number} [now]
 * @returns {{records: object[], changed: number}}
 */
export function markRunningAsOrphaned(records, now = Date.now()) {
  let changed = 0
  const next = (Array.isArray(records) ? records : []).map((record) => {
    if (record === null || typeof record !== 'object' || record.status !== 'running') return record
    changed += 1
    const startedAt = Number.isFinite(record.startedAt) ? record.startedAt : now
    return {
      ...record,
      status: 'orphaned',
      phase: 'orphaned',
      stopReason: 'orphaned',
      error: typeof record.error === 'string' && record.error.length > 0
        ? record.error
        : 'local Host restarted while the remote task was running; remote outcome unknown',
      finishedAt: now,
      durationMs: Math.max(0, now - startedAt),
      orphanedAt: now,
    }
  })
  return { records: next, changed }
}

/**
 * Load + recover the journal in one step.
 * @param {string} [file]
 * @param {number} [now]
 * @returns {{records: object[], changed: number}}
 */
export function recoverJournal(file = journalPath(), now = Date.now()) {
  const loaded = loadJournal(file)
  const recovered = markRunningAsOrphaned(loaded, now)
  if (recovered.changed > 0) saveJournal(recovered.records, file)
  return recovered
}
