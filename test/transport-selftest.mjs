#!/usr/bin/env node
/**
 * Deterministic transport self-test for `lib/acp.js` -> `runRemoteTask()`.
 *
 *   cd plugin/dsh-subagent-remote
 *   node test/transport-selftest.mjs
 *   exit 0 = every check passed; exit 1 = at least one FAIL
 *
 * The real ACP peer is replaced by `test/fixtures/mock-acp-peer.mjs` (selected
 * by MOCK_MODE): no network, no model key, no DSH/Electron installation involved.
 * Covered paths: success, permission allow/deny, permission decider failure
 * (fail-closed), prompt timeout, parent abort, polluted stdout, peer crash
 * during the handshake, unknown server request (must fail closed), foreign
 * session update (protocol violation), credential-shaped env scrubbing, and
 * expected-agent mismatch (version/identity gate).
 *
 * How the fixture is spawned — this is the only non-obvious part:
 *   `buildSpawn()` in local mode calls `resolveLocalDsh()` FIRST, which on
 *   Windows resolves the real `.../runtime/cli/bin/dsh.cmd` and therefore
 *   IGNORES `endpoint.localCommand` / `endpoint.localArgs`. The supported
 *   override hook is the `DSH_CLI_SHIM` env var: the resolver parses that file
 *   for a quoted `*.exe` and a quoted `*.asar…cli.js`, then spawns
 *   `exe --expose-internals <cli.js> --profile acp`.
 *   This test writes a throwaway `dsh.cmd` + `mock-peer.asar/cli.js` launcher in
 *   a temp dir (the launcher imports the fixture by absolute file URL) and
 *   points DSH_CLI_SHIM at it. On POSIX the resolver ignores DSH_CLI_SHIM and
 *   uses `DSH_BIN`, so there we write an executable `#!/bin/sh` wrapper instead.
 *   Both are documented, test-only env overrides — `lib/acp.js` is NOT modified.
 *
 * The suite also proves teardown: the fixture prints its pid on stderr, and every
 * mock peer must be gone once its case returns (no orphan node processes).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildSpawn, buildWindowsRemoteShell, runRemoteTask } from '../lib/acp.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(HERE, 'fixtures')
const PEER_PATH = path.join(FIXTURES_DIR, 'mock-acp-peer.mjs')
const SESSION_CWD = FIXTURES_DIR // must be absolute: ACP session/new requires it

const IS_WINDOWS = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ assertions

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson === expectedJson) {
    passed += 1
    console.log(`ok   ${name}`)
  } else {
    failed += 1
    console.error(`FAIL ${name}: expected ${expectedJson} got ${actualJson}`)
  }
}

function checkTrue(name, value, detail) {
  if (value === true) {
    passed += 1
    console.log(`ok   ${name}`)
  } else {
    failed += 1
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

// ------------------------------------------------------- peer spawn redirection

/**
 * Make `buildSpawn({ mode: 'local' })` resolve to the mock peer.
 * @returns {{dir: string, mechanism: string, expectedCommand: string, launcherPath: string|null, cleanup: () => void}}
 */
function installPeerRouting() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-transport-selftest-'))
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Temp-dir cleanup is best effort.
    }
  }
  if (IS_WINDOWS) {
    // parseable by resolveLocalDsh: one quoted .exe + one quoted *.asar…cli.js
    const launcherDir = path.join(dir, 'mock-peer.asar')
    fs.mkdirSync(launcherDir, { recursive: true })
    const launcherPath = path.join(launcherDir, 'cli.js')
    const peerUrl = pathToFileURL(PEER_PATH).href
    fs.writeFileSync(launcherPath, `import ${JSON.stringify(peerUrl)}\n`, 'utf8')
    const shimPath = path.join(dir, 'dsh.cmd')
    const shim = `@echo off\r\n"${process.execPath}" "${launcherPath}" %*\r\n`
    fs.writeFileSync(shimPath, shim, 'utf8')
    process.env.DSH_CLI_SHIM = shimPath
    return {
      dir,
      mechanism: `DSH_CLI_SHIM=${shimPath} -> ${process.execPath} --expose-internals ${launcherPath} --profile acp`,
      expectedCommand: process.execPath,
      launcherPath,
      cleanup,
    }
  }
  // POSIX: resolveLocalDsh() ignores DSH_CLI_SHIM and spawns DSH_BIN directly.
  const wrapperPath = path.join(dir, 'mock-dsh-peer')
  const wrapper = `#!/bin/sh\nexec '${process.execPath}' '${PEER_PATH}' "$@"\n`
  fs.writeFileSync(wrapperPath, wrapper, 'utf8')
  fs.chmodSync(wrapperPath, 0o755)
  process.env.DSH_BIN = wrapperPath
  return {
    dir,
    mechanism: `DSH_BIN=${wrapperPath} -> ${process.execPath} ${PEER_PATH} --profile acp`,
    expectedCommand: wrapperPath,
    launcherPath: null,
    cleanup,
  }
}

function resolveLower(target) {
  return path.resolve(String(target)).toLowerCase()
}

const routing = installPeerRouting()
process.on('exit', routing.cleanup)

console.log(`transport-selftest: node ${process.version} on ${process.platform}`)
console.log(`mock peer routing: ${routing.mechanism}\n`)

// Fail closed BEFORE spawning anything: if the redirect did not take effect,
// `runRemoteTask` would start the real DSH and hang — never let that happen.
const spec = buildSpawn({ mode: 'local', profile: 'acp', cwd: SESSION_CWD })
check('preflight: spawn command is the mock peer entry', resolveLower(spec.command), resolveLower(routing.expectedCommand))
if (routing.launcherPath !== null) {
  checkTrue(
    'preflight: spawn args carry the mock launcher',
    spec.args.some((arg) => resolveLower(arg) === resolveLower(routing.launcherPath)),
    `args=${JSON.stringify(spec.args)}`,
  )
}
checkTrue('preflight: spawn still appends the acp profile', spec.args.join(' ').includes('--profile acp'), `args=${JSON.stringify(spec.args)}`)
if (failed > 0) {
  console.error('\nABORT: local spawn was not redirected to the mock peer; refusing to run (would spawn the real dsh).')
  process.exit(1)
}

// --------------------------------------------------- SSH carrier construction
// These cases never spawn: they inspect the argv ssh would receive.

const posixSpawn = buildSpawn({ mode: 'ssh', sshHost: 'example-host', cwd: '/srv/work', remoteShell: 'posix' })
const posixCarrier = posixSpawn.args[posixSpawn.args.length - 1]
checkTrue('ssh posix: carrier is sh -c', posixCarrier.startsWith('sh -c '), `carrier=${posixCarrier}`)
checkTrue('ssh posix: carrier keeps pid probe', posixCarrier.includes('DSH_ACP_PID=$$'), `carrier=${posixCarrier}`)
check('ssh posix: ssh argv head', posixSpawn.args.slice(0, 7), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15'])
check('ssh posix: destination followed by --', [posixSpawn.args[9], posixSpawn.args[10]], ['example-host', '--'])

const winSpawn = buildSpawn({ mode: 'ssh', sshHost: 'win-host', cwd: 'C:/Users/x', remoteShell: 'cmd' })
const winCarrier = winSpawn.args[winSpawn.args.length - 1]
check('ssh cmd: default carrier', winCarrier, 'dsh --profile acp')
checkTrue('ssh cmd: no sh -c wrapper', winCarrier.startsWith('sh -c ') === false, `carrier=${winCarrier}`)
checkTrue('ssh cmd: no pid probe', winCarrier.includes('DSH_ACP_PID') === false && winCarrier.includes('>&2') === false, `carrier=${winCarrier}`)
checkTrue('ssh cmd: keeps -T', winSpawn.args.includes('-T'), `args=${JSON.stringify(winSpawn.args)}`)

const winQuoted = buildSpawn({
  mode: 'ssh',
  sshHost: 'win-host',
  cwd: 'C:/Users/x',
  remoteShell: 'cmd',
  remoteCommand: 'C:/Program Files/DSH/dsh.cmd',
  remoteArgs: ['--profile', 'acp'],
})
check('ssh cmd: quoted command path', winQuoted.args[winQuoted.args.length - 1], '"C:/Program Files/DSH/dsh.cmd" --profile acp')
check('ssh cmd: cmd metacharacters are quoted', buildWindowsRemoteShell({ remoteCommand: 'dsh', remoteArgs: ['--flag=a&b'] }), 'dsh "--flag=a&b"')
check('ssh cmd: explicit sshBin wins', buildSpawn({ mode: 'ssh', sshHost: 'win-host', cwd: 'C:/Users/x', remoteShell: 'cmd', sshBin: '/opt/ssh' }).command, '/opt/ssh')

// ------------------------------------------------------------------ run helper

/**
 * Run one real `runRemoteTask()` against the mock peer.
 * @param {'ok'|'permission'|'hang'|'noise'|'crash'} mode MOCK_MODE for the child
 * @param {object} [overrides] extra runRemoteTask options (decide/timeoutMs/signal/...)
 */
async function runPeer(mode, overrides = {}) {
  process.env.MOCK_MODE = mode
  return runRemoteTask({
    endpoint: { mode: 'local', profile: 'acp', cwd: SESSION_CWD, spawnCwd: FIXTURES_DIR },
    promptText: 'transport self-test prompt',
    timeoutMs: 20000,
    decide: async () => ({ allow: true, reason: 'selftest default allow', source: 'selftest' }),
    ...overrides,
  })
}

// ------------------------------------------------------------- process probes

const peerPids = []

function findPeerPid(result) {
  const match = /\[mock\] pid=(\d+)/.exec(result.stderrTail.join('\n'))
  return match === null ? null : Number(match[1])
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitNotAlive(pid, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(50)
  }
  return !isProcessAlive(pid)
}

/**
 * Record the fixture pid from stderr and (when available) prove it is gone.
 * @param {object} result runRemoteTask result
 * @param {string} label case label
 * @param {boolean} required make a missing pid a FAIL (hang cases must prove teardown)
 * @returns {Promise<number|null>}
 */
async function auditPeerProcess(result, label, required) {
  const pid = findPeerPid(result)
  if (pid === null) {
    if (required) check(`${label}: mock peer reported its pid on stderr`, false, true)
    else console.log(`note ${label}: mock peer pid not captured in stderrTail`)
    return null
  }
  peerPids.push({ pid, label })
  if (required) check(`${label}: mock peer reported its pid on stderr`, true, true)
  check(`${label}: mock peer process was reaped`, await waitNotAlive(pid, 3000), true)
  return pid
}

// ----------------------------------------------------------------------- cases

async function caseOk() {
  const result = await runPeer('ok')
  check('ok: stopReason', result.stopReason, 'completed')
  check('ok: text is the concatenation of both chunks', result.text, 'MOCK_REMOTE_OK')
  check('ok: prompt stopReason', result.promptStopReason, 'end_turn')
  check('ok: remoteSessionId', result.remoteSessionId, 'mock-acp-session-1')
  check('ok: agent_message_chunk updates', result.updates.agent_message_chunk, 2)
  check('ok: no stdout noise', result.stdoutNoise.length, 0)
  check('ok: no permission requests', result.permissionLog.length, 0)
  check('ok: no tool calls', result.toolCalls.length, 0)
  check('ok: endpoint label', result.endpoint, 'local:acp')
  checkTrue('ok: spawn label names the mock launcher', /mock-(peer\.asar|dsh-peer)/.test(String(result.spawnLabel)), `spawnLabel=${result.spawnLabel}`)
  check('ok: serverInfo passed through', result.serverInfo?.agentInfo?.name, 'mock-acp-peer')
  check('ok: agentInfo captured for diagnostics', result.agentInfo?.name, 'mock-acp-peer')
  check('ok: no protocol error', result.protocolError, undefined)
  check('ok: session was closed before teardown', result.sessionClosed, true)
  check('ok: fixture saw session/close', result.stderrTail.some((line) => line.includes('session/close')), true)
  check('ok: no error field', result.error, undefined)
  await auditPeerProcess(result, 'ok', false)
}

async function casePermissionAllow() {
  const decisions = []
  const result = await runPeer('permission', {
    decide: async (input) => {
      decisions.push(input)
      return { allow: true, reason: 'selftest allows the write tool', source: 'selftest-allow' }
    },
  })
  check('permission-allow: decide called once', decisions.length, 1)
  check('permission-allow: tool call correlated into decide', decisions[0]?.call?.title, 'bash')
  check('permission-allow: rawInput correlated into decide', decisions[0]?.call?.rawInput?.command, 'rm -rf /tmp/mock-probe')
  check('permission-allow: options forwarded to decide', (decisions[0]?.options ?? []).map((option) => option.optionId).join(','), 'allow-once,reject-once')
  check('permission-allow: toolCallId forwarded to decide', decisions[0]?.toolCallId, 'call-1')
  check('permission-allow: stopReason', result.stopReason, 'completed')
  checkTrue('permission-allow: remote text carries the answered optionId', /permission option=allow-once/.test(result.text), `text=${JSON.stringify(result.text)}`)
  check('permission-allow: permissionLog length', result.permissionLog.length, 1)
  const entry = result.permissionLog[0] ?? {}
  check('permission-allow: log decision', entry.decision, 'allow')
  check('permission-allow: log answeredWith', entry.answeredWith, 'allow-once')
  check('permission-allow: log source', entry.source, 'selftest-allow')
  check('permission-allow: log tool', entry.tool, 'bash')
  check('permission-allow: log input.command', entry.input?.command, 'rm -rf /tmp/mock-probe')
  check('permission-allow: toolCalls captured', result.toolCalls.length, 1)
  check('permission-allow: tool_call updates', result.updates.tool_call, 1)
  check('permission-allow: tool_call_update updates', result.updates.tool_call_update, 1)
  await auditPeerProcess(result, 'permission-allow', false)
}

async function casePermissionDeny() {
  const result = await runPeer('permission', {
    decide: async () => ({ allow: false, reason: 'selftest denies the write tool', source: 'selftest-deny' }),
  })
  check('permission-deny: stopReason', result.stopReason, 'completed')
  checkTrue('permission-deny: remote text carries the answered optionId', /permission option=reject-once/.test(result.text), `text=${JSON.stringify(result.text)}`)
  check('permission-deny: remote text never says allow-once', result.text.includes('allow-once'), false)
  check('permission-deny: permissionLog length', result.permissionLog.length, 1)
  const entry = result.permissionLog[0] ?? {}
  check('permission-deny: log decision', entry.decision, 'reject')
  check('permission-deny: log answeredWith', entry.answeredWith, 'reject-once')
  check('permission-deny: log source', entry.source, 'selftest-deny')
  check('permission-deny: log reason', entry.reason, 'selftest denies the write tool')
  await auditPeerProcess(result, 'permission-deny', false)
}

async function casePermissionPolicyError() {
  const result = await runPeer('permission', {
    decide: async () => {
      throw new Error('selftest decider exploded')
    },
  })
  check('permission-policy-error: stopReason', result.stopReason, 'completed')
  checkTrue('permission-policy-error: transport fails closed to reject-once', /permission option=reject-once/.test(result.text), `text=${JSON.stringify(result.text)}`)
  const entry = result.permissionLog[0] ?? {}
  check('permission-policy-error: log decision', entry.decision, 'reject')
  check('permission-policy-error: log source', entry.source, 'policy-error')
  checkTrue('permission-policy-error: log reason carries the error', /selftest decider exploded/.test(String(entry.reason)), `reason=${entry.reason}`)
  await auditPeerProcess(result, 'permission-policy-error', false)
}

async function caseTimeout() {
  const result = await runPeer('hang', { timeoutMs: 1500 })
  check('timeout: stopReason', result.stopReason, 'aborted')
  check('timeout: prompt settled as cancelled', result.promptStopReason, 'cancelled')
  check('timeout: empty text', result.text, '')
  checkTrue('timeout: prompt budget was honoured (>=1500ms)', result.durationMs >= 1400, `durationMs=${result.durationMs}`)
  checkTrue('timeout: bounded grace period, no 8s hang', result.durationMs < 6000, `durationMs=${result.durationMs}`)
  await auditPeerProcess(result, 'timeout', true)
}

async function caseAbort() {
  const controller = new AbortController()
  let fired = false
  // Fire after the handshake is certainly over (spawn + initialize + session/new
  // measured at ~0.3s locally), so the abort lands on an in-flight prompt; the
  // 60s budget makes sure only the abort can end the run.
  const timer = setTimeout(() => {
    fired = true
    controller.abort()
  }, 1500)
  let result
  try {
    // Huge budget: only the parent abort can end this run.
    result = await runPeer('hang', { timeoutMs: 60000, signal: controller.signal, abortReason: 'selftest: parent turn aborted' })
  } finally {
    clearTimeout(timer)
  }
  check('abort: AbortController fired', fired, true)
  check('abort: stopReason', result.stopReason, 'aborted')
  check('abort: prompt settled as cancelled', result.promptStopReason, 'cancelled')
  checkTrue('abort: returned well before the 60s budget', result.durationMs < 15000, `durationMs=${result.durationMs}`)
  await auditPeerProcess(result, 'abort', true)
}

async function caseNoise() {
  const result = await runPeer('noise')
  check('noise: stopReason', result.stopReason, 'completed')
  check('noise: text is unaffected by the noise line', result.text, 'MOCK_REMOTE_OK')
  checkTrue('noise: non-JSON stdout line captured', result.stdoutNoise.some((line) => line.includes('non-json banner')), `stdoutNoise=${JSON.stringify(result.stdoutNoise)}`)
  check('noise: exactly one noise line', result.stdoutNoise.length, 1)
  await auditPeerProcess(result, 'noise', false)
}

async function caseCrash() {
  const startedAt = Date.now()
  const result = await runPeer('crash')
  const elapsed = Date.now() - startedAt
  check('crash: stopReason', result.stopReason, 'error')
  checkTrue('crash: error names the peer exit code', /code=3/.test(String(result.error ?? '')), `error=${result.error}`)
  checkTrue(
    'crash: error or stderrTail carries diagnostics',
    /code=3/.test(String(result.error ?? '')) || result.stderrTail.some((line) => line.includes('crash-before-initialize')),
    `stderrTail=${JSON.stringify(result.stderrTail)}`,
  )
  check('crash: no session was created', result.remoteSessionId, null)
  checkTrue('crash: returned promptly (no hang on the dead peer)', elapsed < 1500, `elapsedMs=${elapsed}`)
}

async function caseUnknownRequest() {
  const startedAt = Date.now()
  const result = await runPeer('unknown-request', { timeoutMs: 15000 })
  const elapsed = Date.now() - startedAt
  check('unknown-request: stopReason', result.stopReason, 'error')
  checkTrue(
    'unknown-request: error names the unsupported request',
    /unsupported server request|protocol violation/i.test(String(result.error ?? '')),
    `error=${result.error}`,
  )
  checkTrue('unknown-request: protocolError recorded', /item\/weird\/request/.test(String(result.protocolError ?? '')), `protocolError=${result.protocolError}`)
  check('unknown-request: failure stage', result.failureStage, 'prompt')
  checkTrue('unknown-request: failed closed promptly (no hang)', elapsed < 5000, `elapsedMs=${elapsed}`)
  await auditPeerProcess(result, 'unknown-request', false)
}

async function caseSessionMismatch() {
  const result = await runPeer('session-mismatch', { timeoutMs: 15000 })
  check('session-mismatch: stopReason', result.stopReason, 'error')
  checkTrue(
    'session-mismatch: error names the foreign session',
    /another session/i.test(String(result.error ?? '')),
    `error=${result.error}`,
  )
  checkTrue('session-mismatch: protocolError recorded', /another session/i.test(String(result.protocolError ?? '')), `protocolError=${result.protocolError}`)
  check('session-mismatch: local text never contains the foreign answer', result.text.includes('FOREIGN'), false)
  await auditPeerProcess(result, 'session-mismatch', true)
}

async function caseSessionKept() {
  const result = await runPeer('ok', { closeRemoteSession: false })
  check('session-keep: stopReason', result.stopReason, 'completed')
  check('session-keep: sessionClosed is false', result.sessionClosed, false)
  check('session-keep: fixture never saw session/close', result.stderrTail.some((line) => line.includes('session/close')), false)
  check('session-keep: answer still returned', /MOCK_REMOTE_OK/.test(result.text), true)
  await auditPeerProcess(result, 'session-keep', false)
}

async function caseEnvScrub() {
  process.env.MOCK_API_KEY = 'must-not-reach-the-peer'
  process.env.MOCK_ALLOWED = 'inherited-value'
  let result
  try {
    result = await runPeer('env', { scrubEnv: true, env: { MOCK_ALLOWED: 'explicit-value' } })
  } finally {
    delete process.env.MOCK_API_KEY
    delete process.env.MOCK_ALLOWED
  }
  check('env-scrub: stopReason', result.stopReason, 'completed')
  check('env-scrub: credential var did not reach the peer', result.text, 'env MOCK_API_KEY=absent MOCK_ALLOWED=explicit-value')
  checkTrue('env-scrub: scrubbed names reported', (result.envScrubbed ?? []).includes('MOCK_API_KEY'), `envScrubbed=${JSON.stringify(result.envScrubbed)}`)
}

async function caseAgentMismatch() {
  const result = await runPeer('ok', { expectAgentName: 'some-other-agent' })
  check('agent-mismatch: stopReason', result.stopReason, 'error')
  checkTrue('agent-mismatch: error names the expectation', /not the expected agent/i.test(String(result.error ?? '')), `error=${result.error}`)
  check('agent-mismatch: failure stage', result.failureStage, 'initialize')
  check('agent-mismatch: observed agent still recorded', result.agentInfo?.name, 'mock-acp-peer')
}

async function caseOnUpdate() {
  const seen = []
  const result = await runPeer('permission', {
    decide: async () => ({ allow: true, reason: 'selftest onUpdate', source: 'selftest' }),
    onUpdate: (kind) => { seen.push(kind) },
  })
  check('onUpdate: run still completes', result.stopReason, 'completed')
  checkTrue('onUpdate: saw a tool_call update', seen.includes('tool_call'), `seen=${JSON.stringify(seen)}`)
  check('onUpdate: observer never changes the answer', result.text, 'permission option=allow-once')
  await auditPeerProcess(result, 'onUpdate', false)
}

// ---------------------------------------------------------------------- runner

const cases = [
  ['ok', 'ok', caseOk],
  ['permission-allow', 'permission', casePermissionAllow],
  ['permission-deny', 'permission', casePermissionDeny],
  ['permission-policy-error', 'permission', casePermissionPolicyError],
  ['timeout', 'hang', caseTimeout],
  ['abort', 'hang', caseAbort],
  ['noise', 'noise', caseNoise],
  ['crash', 'crash', caseCrash],
  ['unknown-request', 'unknown-request', caseUnknownRequest],
  ['session-mismatch', 'session-mismatch', caseSessionMismatch],
  ['session-keep', 'ok', caseSessionKept],
  ['env-scrub', 'env', caseEnvScrub],
  ['agent-mismatch', 'ok', caseAgentMismatch],
  ['onUpdate', 'permission', caseOnUpdate],
]

for (const [name, mode, run] of cases) {
  console.log(`\n-- ${name} (MOCK_MODE=${mode}) --`)
  try {
    await run()
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: unexpected throw: ${error?.stack ?? error}`)
  }
}

// --------------------------------------------------------------- orphan audit

console.log('\n-- orphan process audit --')
const alive = peerPids.filter(({ pid }) => isProcessAlive(pid))
if (alive.length === 0) {
  passed += 1
  console.log(`ok   orphan audit: all ${peerPids.length} mock peer process(es) exited (${peerPids.map(({ pid }) => pid).join(', ') || 'none recorded'})`)
} else {
  failed += 1
  console.error(`FAIL orphan audit: still running: ${alive.map(({ label, pid }) => `${label}:${pid}`).join(', ')}`)
}

const total = passed + failed
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} transport-selftest: ${passed}/${total} checks passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

