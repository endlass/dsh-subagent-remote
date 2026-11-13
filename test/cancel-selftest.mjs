#!/usr/bin/env node
/**
 * Deterministic unit tests for the `cancelRun` method of the settings RPC.
 *
 * The user-facing Stop button is the only destructive control this plugin adds,
 * so its transport contract is pinned here: unknown and already settled runs are
 * normal answers (the UI polls and may race the settlement), a missing run id is
 * a bad request, and a host-side throw never becomes an unhandled rejection.
 *
 *   node test/cancel-selftest.mjs
 *   exit 0 = all checks passed
 */
import { RPC_PATH, registerSettingsRpc } from '../lib/settings.js'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed += 1
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

/** Capture the registered fetch handler instead of starting a Host. */
function mount(parts) {
  let handler
  const ctx = {
    connection: {
      fetch: {
        register(config) {
          handler = config
          return () => {}
        },
      },
    },
  }
  registerSettingsRpc(ctx, {
    getHosts: () => [],
    buildHosts: () => [],
    applyHosts: () => ({ added: [], removed: [], updated: [] }),
    getState: () => ({}),
    setState: () => ({}),
    ...parts,
  })
  if (handler === undefined) throw new Error('settings RPC did not register')
  return handler
}

async function call(handler, method, payload) {
  const request = new Request(`http://127.0.0.1${RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: RPC_PATH, payload: { method, payload } }),
  })
  const response = await handler.fetch(request)
  const body = await response.json()
  return body.result
}

// --- happy path -----------------------------------------------------------
const cancelled = []
const handler = mount({ cancelRun: (runId) => { cancelled.push(runId); return { cancelled: true } } })
check('cancelRun acknowledges a live run', await call(handler, 'cancelRun', { runId: 'run-1' }), { ok: true, value: { cancelled: true } })
check('cancelRun forwards the run id', cancelled, ['run-1'])
check('run ids are trimmed', await call(handler, 'cancelRun', { runId: '  run-2  ' }), { ok: true, value: { cancelled: true } })
check('trimmed id forwarded', cancelled, ['run-1', 'run-2'])

// --- idempotent / racing answers -----------------------------------------
const settled = mount({ cancelRun: () => ({ cancelled: false, reason: 'not-running' }) })
check('unknown run is a normal answer', await call(settled, 'cancelRun', { runId: 'gone' }), { ok: true, value: { cancelled: false, reason: 'not-running' } })

const throwing = mount({ cancelRun: () => { throw new Error('peer already gone') } })
check('host throw is reported, not surfaced as a rejection', await call(throwing, 'cancelRun', { runId: 'run-3' }), { ok: true, value: { cancelled: false, reason: 'failed: peer already gone' } })

const unsupported = mount({})
check('host without the seam answers unsupported', await call(unsupported, 'cancelRun', { runId: 'run-4' }), { ok: true, value: { cancelled: false, reason: 'unsupported' } })

const odd = mount({ cancelRun: () => undefined })
check('malformed host answer is normalized', await call(odd, 'cancelRun', { runId: 'run-5' }), { ok: true, value: { cancelled: false, reason: 'unsupported' } })

// --- validation -----------------------------------------------------------
check('missing run id is a bad request', (await call(handler, 'cancelRun', {})).ok, false)
check('blank run id is a bad request', (await call(handler, 'cancelRun', { runId: '   ' })).ok, false)

// --- unchanged neighbours -------------------------------------------------
const runsHandler = mount({ getRuns: (sessionId) => [{ id: 'run-1', sessionId }] })
check('runs still answers', await call(runsHandler, 'runs', { sessionId: 's1' }), { ok: true, value: { runs: [{ id: 'run-1', sessionId: 's1' }] } })
check('unknown method still rejected', (await call(runsHandler, 'nope', {})).ok, false)

console.log(failed === 0 ? '\nPASS cancel-selftest' : `\nFAIL cancel-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
