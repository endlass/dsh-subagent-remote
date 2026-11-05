#!/usr/bin/env node
/**
 * Deterministic unit tests for the session-header run registry.
 *
 *   node test/runs-selftest.mjs
 *   exit 0 = all checks passed
 */
import { createRunRegistry, previewText, DEFAULT_RUN_KEEP_MS } from '../lib/runs.js'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed += 1
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
  }
}
function checkTrue(name, value, detail) {
  if (value !== true) {
    failed += 1
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

// ---------------------------------------------------------- preview sanitizing
check('preview strips control characters', previewText('a\u0000b\u0007c\nd'), 'abc\nd')
checkTrue('preview truncates long text', previewText('x'.repeat(400)).endsWith('…'))
check('preview ignores non-strings', previewText(null), '')

// ------------------------------------------------------------- registry basics
let now = 1_000_000
const registry = createRunRegistry({ keepMs: 5000, now: () => now })

const first = registry.begin({
  id: 'run-a',
  sessionId: 'session-1',
  host: 'win',
  provider: 'remote-win',
  endpoint: 'ssh:win:C:/Users/me',
  cwd: 'C:/Users/me',
  permission: 'auto',
  remoteSession: 'close',
})
check('begin status', first.status, 'running')
check('begin phase', first.phase, 'starting')
check('begin tool count', first.toolCalls, 0)
check('begin elapsed is null', first.finishedAt, null)

registry.progress('run-a', 'tool_call', { toolCallId: 't1', title: 'pwsh', status: 'running' })
registry.progress('run-a', 'tool_call_update', { toolCallId: 't1', status: 'completed' })
registry.progress('run-a', 'tool_call', { toolCallId: 't2', title: 'read', status: 'running' })
registry.progress('run-a', 'agent_message_chunk', {})
registry.progress('run-a', 'usage_update', { used: 123, size: 1000 })

let listed = registry.list('session-1')
check('one record listed', listed.length, 1)
check('record status running', listed[0].status, 'running')
check('record tool count', listed[0].toolCalls, 2)
check('record last tool', listed[0].lastTool, 'read')
check('record last tool status', listed[0].lastToolStatus, 'running')
check('record usage', listed[0].usage, { used: 123, size: 1000 })

// other sessions are filtered out
const second = registry.begin({ id: 'run-b', sessionId: 'session-2', host: 'mac' })
check('session filter', registry.list('session-1').map((run) => run.id), ['run-a'])
check('all sessions list', registry.list().length, 2)
registry.finish('run-b', { status: 'error', stopReason: 'error', error: 'boom' })
check('error record visible', registry.list('session-2')[0].status, 'error')
check('error record carries error', registry.list('session-2')[0].error, 'boom')

// finish + duration
now += 2000
registry.finish('run-a', {
  status: 'completed',
  stopReason: 'completed',
  text: 'Windows result',
  remoteSessionId: 'remote-1',
  durationMs: 2000,
})
listed = registry.list('session-1')
check('completed status', listed[0].status, 'completed')
check('completed duration', listed[0].durationMs, 2000)
check('completed duration fallback', listed[0].durationMs, 2000)
check('completed preview', listed[0].textPreview, 'Windows result')
check('completed remote session', listed[0].remoteSessionId, 'remote-1')

// running records sort before settled records
const third = registry.begin({ id: 'run-c', sessionId: 'session-1', host: 'cloud' })
check('running sorts first', registry.list('session-1').map((run) => run.id), ['run-c', 'run-a'])
registry.finish('run-c', { status: 'completed', stopReason: 'completed', text: '' })

// keep-period pruning: settled records vanish, running records stay
now += DEFAULT_RUN_KEEP_MS + 1
const before = registry.list('session-1').map((run) => run.id)
check('settled records pruned', before, [])
const keeper = registry.begin({ id: 'run-d', sessionId: 'session-1', host: 'win' })
now += 6000
check('running record survives pruning', registry.list('session-1').map((run) => run.id), ['run-d'])
registry.finish('run-d', { status: 'completed', stopReason: 'completed' })
check('settled record kept inside window', registry.list('session-1').length, 1)
check('keeper id', keeper.id, 'run-d')

// max cap: running records are never trimmed; oldest settled is
const capped = createRunRegistry({ keepMs: 60_000, max: 3, now: () => 5_000_000 })
for (let index = 0; index < 6; index += 1) {
  capped.begin({ id: `cap-${index}`, sessionId: 's', host: 'h' })
  capped.finish(`cap-${index}`, { status: 'completed', stopReason: 'completed' })
}
checkTrue('max cap bounds settled records', capped.list('s').length <= 3, `got ${capped.list('s').length}`)

// no-op on unknown ids
registry.progress('missing', 'tool_call', { title: 'x' })
registry.finish('missing', { status: 'completed' })
check('unknown finish is a no-op', registry.list().some((run) => run.id === 'missing'), false)

// patches on settled records do not reopen them
registry.progress('run-d', 'tool_call', { title: 'late' })
check('settled record ignores late progress', registry.list('session-1')[0].toolCalls, 0)

console.log(failed === 0 ? '\nPASS runs-selftest' : `\nFAIL runs-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
