#!/usr/bin/env node
/**
 * Deterministic unit tests for the settings overlay, host selection and RPC
 * envelope contract (no DSH, no network).
 *
 *   node test/settings-selftest.mjs
 *   exit 0 = all checks passed
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeHosts,
  createHostSelection,
  describeHostSwitcher,
  renderDiagnostic,
} from '../index.js'
import {
  RPC_PATH,
  applyHostOverlay,
  buildStatePayload,
  parseRpcRequest,
  projectHost,
  readState,
  sanitizeOverlayHostPatch,
  writeState,
} from '../lib/settings.js'

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
function expectThrow(name, fn, pattern) {
  try {
    fn()
    failed += 1
    console.error(`FAIL ${name}: expected a throw`)
  } catch (error) {
    const ok = pattern.test(error.message)
    if (ok) console.log(`ok   ${name}`)
    else {
      failed += 1
      console.error(`FAIL ${name}: message ${JSON.stringify(error.message)} does not match ${pattern}`)
    }
  }
}

// --- remote session policy + host selection ------------------------------
const policyHosts = normalizeHosts({ hosts: [
  { name: 'a', ssh: 'example-host', cwd: '/srv/work' },
  { name: 'b', ssh: 'example-host', cwd: '/srv/work', remoteSession: 'keep' },
] })
check('remoteSession default close', policyHosts[0].remoteSession, 'close')
check('remoteSession keep', policyHosts[1].remoteSession, 'keep')
expectThrow('bad remoteSession', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', remoteSession: 'delete' }), /remoteSession must be "close" or "keep"/)

const selection = createHostSelection(policyHosts, {
  configDefault: 'a',
  readPersistedDefault: () => undefined,
})
check('selection base uses config default', selection.base(), 'a')
const persistedSelection = createHostSelection(policyHosts, {
  configDefault: 'a',
  readPersistedDefault: () => 'b',
})
check('persisted default wins over config', persistedSelection.base(), 'b')
const single = createHostSelection([policyHosts[0]], { readPersistedDefault: () => undefined })
check('single host auto-selected', single.resolve({ session: { id: 's1' } }), 'a')
selection.select('s1', 'b')
check('session selection wins', selection.resolve({ session: { id: 's1' } }), 'b')
check('other session uses base', selection.resolve({ session: { id: 's2' } }), 'a')
check('current reports session', selection.current('s1'), 'b')
selection.clear('s1')
check('clear falls back to base', selection.current('s1'), 'a')
expectThrow('select unknown host', () => selection.select('s1', 'zzz'), /unknown remote host/)

const listing = describeHostSwitcher(policyHosts, selection, undefined)
check('listing names hosts', /- a\s+ssh:example-host/.test(listing) && /- b\s+ssh:example-host/.test(listing), true)
check('listing marks current', /← 当前/.test(listing), true)
check('listing mentions usage', /\/remote-host/.test(listing), true)

// --- overlay merge / sanitize / state persistence -----------------------
const overlayMerged = applyHostOverlay({ hosts: [
  { name: 'a', ssh: 'example-host', cwd: '/srv/work' },
  { name: 'b', ssh: 'example-host', cwd: '/home/b' },
] }, {
  a: { cwd: '/srv/a', permission: 'ask', bogus: 1 },
  c: { ssh: 'example-host', cwd: '/srv/c', remoteSession: 'keep' },
})
check('overlay keeps host count + appends', overlayMerged.hosts.length, 3)
check('overlay overrides cwd', overlayMerged.hosts[0].cwd, '/srv/a')
check('overlay overrides permission', overlayMerged.hosts[0].permission, 'ask')
check('overlay drops unknown fields', overlayMerged.hosts[0].bogus, undefined)
check('overlay appended host fields', [overlayMerged.hosts[2].name, overlayMerged.hosts[2].remoteSession], ['c', 'keep'])
check('overlay leaves untouched host', overlayMerged.hosts[1].cwd, '/home/b')

check('sanitize accepts valid patch', sanitizeOverlayHostPatch({ cwd: '/srv/x', permission: 'deny', remoteSession: 'keep', scrubEnv: false }), { cwd: '/srv/x', permission: 'deny', remoteSession: 'keep', scrubEnv: false })
check('sanitize accepts host description', sanitizeOverlayHostPatch({ description: 'Windows 11 workstation' }), { description: 'Windows 11 workstation' })
expectThrow('sanitize rejects empty description', () => sanitizeOverlayHostPatch({ description: '   ' }), /description must be a non-empty string/)
expectThrow('sanitize rejects long description', () => sanitizeOverlayHostPatch({ description: 'x'.repeat(501) }), /at most 500 characters/)
expectThrow('sanitize rejects relative cwd', () => sanitizeOverlayHostPatch({ cwd: 'rel/path' }), /cwd must be an absolute path/)
expectThrow('sanitize rejects bad permission', () => sanitizeOverlayHostPatch({ permission: 'yolo' }), /permission must be/)
expectThrow('sanitize rejects empty patch', () => sanitizeOverlayHostPatch({}), /changed nothing/)

const tempDir = mkdtempSync(join(tmpdir(), 'dsr-state-'))
try {
  const file = join(tempDir, 'subagent-remote.json')
  check('read missing state', readState(file), {})
  const saved = writeState({ defaultHost: 'b', autoPrompt: false, hosts: { b: { cwd: '/srv/b' } } }, file)
  check('writeState stamps updatedAt', typeof saved.updatedAt, 'string')
  check('readState roundtrip', readState(file), { defaultHost: 'b', autoPrompt: false, hosts: { b: { cwd: '/srv/b' } }, updatedAt: saved.updatedAt })
  check('writeState leaves no temp files', readdirSync(tempDir).filter((name) => name.endsWith('.tmp')).length, 0)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

const payload = buildStatePayload(policyHosts, { defaultHost: 'b', hosts: { b: { cwd: '/srv/b' } } }, 'a')
check('payload default prefers settings', payload.defaultHost, 'b')
check('payload default source', payload.defaultSource, 'settings')
check('payload flags overlay host', payload.hosts[1].fromOverlay, true)
check('payload marks yaml host', payload.hosts[0].fromOverlay, false)
check('payload advertises hot reload', payload.hotReload, true)
// hosts are the *live* runtime list; the overlay projects cwd=/srv/b over the live
// /srv/work, so b is flagged as pending until the plugin applies it.
check('payload flags pending overlay edit', payload.pendingHostEdits, ['b'])
check('payload per-host pending flag', payload.hosts[1].pendingRestart, true)
check('payload yaml host not pending', payload.hosts[0].pendingRestart, false)
check('payload keeps live view for pending host', payload.hosts[1].live.cwd, '/srv/work')
check('payload autoPrompt default true', buildStatePayload(policyHosts, {}, undefined).autoPrompt, true)
check('payload autoPrompt false', buildStatePayload(policyHosts, { autoPrompt: false }, undefined).autoPrompt, false)
check('payload config default source', buildStatePayload(policyHosts, {}, 'a').defaultSource, 'config')
check('payload no default source', buildStatePayload(policyHosts, {}, undefined).defaultSource, 'none')
check('payload no pending edits when overlay empty', buildStatePayload(policyHosts, {}, undefined).pendingHostEdits, [])
const projectSample = projectHost(policyHosts[0], { permission: 'ask', ssh: 'other' })
check('projectHost applies overlay', [projectSample.permission, projectSample.endpoint], ['ask', 'ssh:other'])
check('projectHost defaults disabled false', projectSample.disabled, false)
check('projectHost projects disabled', projectHost(policyHosts[0], { disabled: true }).disabled, true)
const disabledPayload = buildStatePayload([{ ...policyHosts[0], disabled: true }, policyHosts[1]], {}, undefined)
check('payload marks disabled host', disabledPayload.hosts[0].disabled, true)
check('payload live view marks disabled', disabledPayload.hosts[0].live.disabled, true)
check('payload disabled host not pending', disabledPayload.hosts[0].pendingRestart, false)

// --- RPC envelope validation --------------------------------------------
const goodEnvelope = { type: 'client-request', rpcId: 'r1', method: RPC_PATH, payload: { method: 'state', payload: {} } }
check('rpc parses valid envelope', parseRpcRequest(goodEnvelope), { ok: true, rpcId: 'r1', method: 'state', payload: {} })
check('rpc rejects wrong type', parseRpcRequest({ ...goodEnvelope, type: 'x' }).ok, false)
check('rpc rejects wrong method', parseRpcRequest({ ...goodEnvelope, method: '/api/other' }).ok, false)
check('rpc rejects missing rpcId', parseRpcRequest({ ...goodEnvelope, rpcId: '' }).ok, false)
check('rpc rejects bad payload', parseRpcRequest({ ...goodEnvelope, payload: 'x' }).ok, false)

// --- diagnostic remote session action -----------------------------------
const closedDiag = renderDiagnostic({ endpoint: 'ssh:example-host:/srv/work', cwd: '/srv/work', stopReason: 'completed', durationMs: 1, remoteSessionId: 's', sessionClosed: true })
check('diagnostic says closed', /remoteSessionAction=closed/.test(closedDiag), true)
const keptDiag = renderDiagnostic({ endpoint: 'ssh:example-host:/srv/work', cwd: '/srv/work', stopReason: 'completed', durationMs: 1, remoteSessionId: 's', sessionClosed: false })
check('diagnostic says kept', /remoteSessionAction=kept/.test(keptDiag), true)

console.log(failed === 0 ? '\nPASS settings-selftest' : `\nFAIL settings-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
