#!/usr/bin/env node
/**
 * Deterministic tests for the durable run journal.
 *
 *   node test/journal-selftest.mjs
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JOURNAL_VERSION,
  journalPath,
  loadJournal,
  markRunningAsOrphaned,
  recoverJournal,
  saveJournal,
} from '../lib/journal.js'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) console.log(`ok   ${name}`)
  else { failed += 1; console.error(`FAIL ${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`) }
}
function checkTrue(name, value, detail) {
  if (value === true) console.log(`ok   ${name}`)
  else { failed += 1; console.error(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsr-journal-'))
const file = join(dir, 'runs.json')
try {
  check('missing journal is empty', loadJournal(file), [])

  const running = {
    id: 'run-1', sessionId: 's1', host: 'win', provider: 'remote-win', endpoint: 'ssh:win:C:/x', cwd: 'C:/x',
    permission: 'auto', remoteSession: 'close', status: 'running', phase: 'running',
    toolCalls: 2, lastTool: 'pwsh', lastToolStatus: 'running', startedAt: 1000,
    finishedAt: null, durationMs: null, stopReason: null, error: null, textPreview: '',
    remoteSessionId: 'remote-1', usage: { used: 1, size: 10 }, orphanedAt: null,
  }
  check('save journal', saveJournal([running], file), true)
  const loaded = loadJournal(file)
  check('roundtrip count', loaded.length, 1)
  check('roundtrip id', loaded[0].id, 'run-1')
  check('roundtrip tool', loaded[0].lastTool, 'pwsh')
  check('no temp files left', readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0)

  const marked = markRunningAsOrphaned(loaded, 5000)
  check('orphan count', marked.changed, 1)
  check('orphan status', marked.records[0].status, 'orphaned')
  check('orphan phase', marked.records[0].phase, 'orphaned')
  check('orphan stop reason', marked.records[0].stopReason, 'orphaned')
  check('orphan finishedAt', marked.records[0].finishedAt, 5000)
  check('orphan duration', marked.records[0].durationMs, 4000)
  check('orphan keeps remote session', marked.records[0].remoteSessionId, 'remote-1')

  check('recoverJournal writes marks', recoverJournal(file, 6000).changed, 1)
  check('recovered file no longer running', loadJournal(file)[0].status, 'orphaned')
  check('recoverJournal is idempotent', recoverJournal(file, 7000).changed, 0)

  writeFileSync(file, '{ broken json', 'utf8')
  check('corrupt journal is empty', loadJournal(file), [])
  writeFileSync(file, JSON.stringify({ version: 999, runs: [] }), 'utf8')
  check('wrong version is empty', loadJournal(file), [])
  check('save rejects non-array', saveJournal(null, file), false)

  check('journal path uses DSH_HOME', (() => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    const resolved = journalPath()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    return resolved
  })(), join(dir, 'storages', 'dsh-subagent-remote', 'runs.json'))
  check('journal version', JOURNAL_VERSION, 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nPASS journal-selftest' : `\nFAIL journal-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
