#!/usr/bin/env node
/**
 * Deterministic unit tests for config normalization and failure diagnostics.
 *
 *   node test/config-selftest.mjs
 *   exit 0 = all checks passed
 */
import {
  normalizeHosts,
  pickSessionCwd,
  normalizeToolConfig,
  validateTaskPrompt,
  diagnoseFailure,
  classifyFailureFacts,
  renderDiagnostic,
  PERMISSION_MODES,
  REMOTE_SHELLS,
  FAILURE_CATEGORIES,
  isWindowsAbsolutePath,
} from '../index.js'
import { decodePeerStderr, resolveLocalDsh, scrubEnv } from '../lib/acp.js'
import {
  RPC_PATH,
  applyHostOverlay,
  buildStatePayload,
  parseRpcRequest,
  readState,
  sanitizeOverlayHostPatch,
  writeState,
} from '../lib/settings.js'
import { createHostSelection, describeHostSwitcher } from '../index.js'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// --- permission modes -----------------------------------------------------
check('permission modes', PERMISSION_MODES, ['read-only', 'ask', 'deny', 'auto'])

// --- single-host shorthand ----------------------------------------------
const single = normalizeHosts({ ssh: 'example-host', cwd: '/srv/work' })
check('single host count', single.length, 1)
check('single host name default', single[0].name, 'host0')
check('single host provider default', single[0].provider, 'remote-host0')
check('single host mode', single[0].mode, 'ssh')
check('single host permission default', single[0].permission, 'read-only')
check('single host timeout default', single[0].timeoutMs, 600000)
check('single host remoteShell auto posix', single[0].remoteShell, 'posix')

// --- Windows remote auto-detection / explicit carrier ---------------------
check('remote shells', REMOTE_SHELLS, ['posix', 'cmd'])
check('windows path helper accepts drive letter', isWindowsAbsolutePath('C:/Users/x'), true)
check('windows path helper rejects posix', isWindowsAbsolutePath('/srv/work'), false)
check('windows cwd auto-selects cmd', normalizeHosts({ ssh: 'example-host', cwd: 'C:/Users/x' })[0].remoteShell, 'cmd')
check('windows cwd backslash auto-selects cmd', normalizeHosts({ ssh: 'example-host', cwd: 'C:\\Users\\x' })[0].remoteShell, 'cmd')
check('posix cwd auto-selects posix', normalizeHosts({ ssh: 'example-host', cwd: '/srv/work' })[0].remoteShell, 'posix')
check('explicit remoteShell wins', normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', remoteShell: 'cmd' })[0].remoteShell, 'cmd')
check('explicit posix on windows path', normalizeHosts({ ssh: 'example-host', cwd: 'C:/Users/x', remoteShell: 'posix' })[0].remoteShell, 'posix')
expectThrow('bad remoteShell', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', remoteShell: 'sh' }), /remoteShell must be one of/)

// --- hosts array ----------------------------------------------------------
const hosts = normalizeHosts({
  hosts: [
    { name: 'host-a', provider: 'remote-host-a', ssh: 'example-host', cwd: '/srv/work', permission: 'ask', timeoutMs: 1000, sshArgs: ['-o', 'X=1'] },
    { name: 'local', local: true, profile: 'acp', cwd: 'C:\\tmp' },
  ],
})
check('two hosts', hosts.length, 2)
check('host 0 permission', hosts[0].permission, 'ask')
check('host 0 timeout', hosts[0].timeoutMs, 1000)
check('host 0 sshArgs', hosts[0].sshArgs, ['-o', 'X=1'])
check('host 1 local mode', hosts[1].mode, 'local')
check('host 1 provider derived', hosts[1].provider, 'remote-local')
check('host 1 profile', hosts[1].profile, 'acp')

// --- config errors are loud and name the field ---------------------------
check('empty hosts list is valid', normalizeHosts({ hosts: [] }), [])
expectThrow('hosts must be an array', () => normalizeHosts({ hosts: 'x' }), /must be an array/)
expectThrow('missing ssh', () => normalizeHosts({ cwd: '/srv/work' }), /needs "ssh"/)
expectThrow('relative cwd', () => normalizeHosts({ ssh: 'example-host', cwd: 'relative/path' }), /cwd must be an absolute path/)
expectThrow('bad permission', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', permission: 'yolo' }), /permission must be one of/)
expectThrow('bad timeout', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', timeoutMs: 0 }), /timeoutMs must be a positive finite/)
expectThrow('bad sshArgs', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', sshArgs: '-o X=1' }), /sshArgs must be an array of strings/)
expectThrow('bad sshBin', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', sshBin: 42 }), /sshBin must be a non-empty string/)
expectThrow('duplicate host name', () => normalizeHosts({ hosts: [
  { name: 'a', ssh: 'example-host', cwd: '/srv/work' },
  { name: 'a', ssh: 'example-host', cwd: '/tmp' },
] }), /duplicate host name/)
expectThrow('duplicate provider', () => normalizeHosts({ hosts: [
  { name: 'a', provider: 'p', ssh: 'example-host', cwd: '/srv/work' },
  { name: 'b', provider: 'p', ssh: 'example-host', cwd: '/tmp' },
] }), /duplicate provider name/)
expectThrow('non-object entry', () => normalizeHosts({ hosts: ['nope'] }), /must be an object/)

// --- cwd mapping ---------------------------------------------------------
check('ssh keeps posix cwd', pickSessionCwd('/srv/work/work', '/srv/work', 'ssh'), '/srv/work/work')
check('ssh rejects windows cwd', pickSessionCwd('C:\\Users\\x', '/srv/work', 'ssh'), '/srv/work')
check('windows remote keeps configured cwd', pickSessionCwd('/private/tmp', 'C:/Users/x', 'ssh'), 'C:/Users/x')
check('local keeps windows cwd', pickSessionCwd('C:\\Users\\x', '/srv/work', 'local'), 'C:\\Users\\x')
check('undefined falls back', pickSessionCwd(undefined, '/srv/work', 'ssh'), '/srv/work')

// --- tool config ---------------------------------------------------------
check('tool config absent', normalizeToolConfig(undefined), undefined)
check('tool config empty', normalizeToolConfig({}), {})
check('tool config name', normalizeToolConfig({ name: 'remote_subagent' }), { name: 'remote_subagent' })
check('tool config description', normalizeToolConfig({ description: 'x' }), { description: 'x' })
expectThrow('tool config must be object', () => normalizeToolConfig('x'), /"tool" must be an object/)
expectThrow('tool name must be string', () => normalizeToolConfig({ name: 3 }), /tool.name must be a non-empty string/)

// --- failure hints -------------------------------------------------------
const sshNoBin = diagnoseFailure({ error: 'spawn ssh ENOENT', mode: 'ssh' })
check('hint for missing ssh', /SSH client not found/.test(sshNoBin.join(' ')), true)
const localNoBin = diagnoseFailure({ error: 'spawn dsh ENOENT', mode: 'local' })
check('hint for missing local dsh', /Local dsh executable not found/.test(localNoBin.join(' ')), true)
check('hint for host key', /Host key is not trusted/.test(diagnoseFailure({ error: 'Host key verification failed' }).join(' ')), true)
check('hint for auth', /SSH auth failed/.test(diagnoseFailure({ error: 'Permission denied (publickey)' }).join(' ')), true)
check('hint for resolve', /could not be resolved/.test(diagnoseFailure({ error: 'Could not resolve hostname example-host' }).join(' ')), true)
check('hint for cwd', /workspace rejected/.test(diagnoseFailure({ error: 'cwd must be an absolute path: x' }).join(' ')), true)
check('hint for credentials', /no usable model credentials/.test(diagnoseFailure({ stderrTail: ['MISSING_CREDENTIAL'] }).join(' ')), true)
check('hint for handshake', /did not finish the handshake/.test(diagnoseFailure({ error: 'initialize timed out after 120000ms' }).join(' ')), true)
check('hint for sandbox', /blocked by the local sandbox/.test(diagnoseFailure({ error: 'spawn EPERM' }).join(' ')), true)
check('no hints for plain error', diagnoseFailure({ error: 'boom' }), [])
// An SSH-level failure must not also claim the ACP handshake is at fault.
const resolveHints = diagnoseFailure({
  error: 'ACP peer exited before answering (code=255 signal=null)',
  stderrTail: ['ssh: Could not resolve hostname nope.invalid'],
  mode: 'ssh',
})
check('resolve failure has resolve hint', /could not be resolved/.test(resolveHints.join(' ')), true)
check('resolve failure has no handshake hint', /did not finish the handshake/.test(resolveHints.join(' ')), false)

// --- stderr decoding (UTF-8 vs GBK vs binary vs OpenSSH octal spelling) ---
check('stderr decodes utf8', decodePeerStderr(Buffer.from('ssh: 连接超时', 'utf8')), 'ssh: 连接超时')
const gbk = Buffer.from([0xb2, 0xbb, 0xd6, 0xaa, 0xb5, 0xc0, 0xd5, 0xe2, 0xd1, 0xf9, 0xb5, 0xc4, 0xd6, 0xf7, 0xbb, 0xfa, 0xa1, 0xa3])
check('stderr decodes gbk', decodePeerStderr(gbk), '不知道这样的主机。')
// What Windows OpenSSH actually writes when stderr is a pipe (ASCII octal spelling of GBK bytes).
const octalFromSsh = String.raw`ssh: Could not resolve hostname x.invalid: \262\273\326\252\265\300\325\342\321\371\265\304\326\367\273\372\241\243 `
check('stderr unescapes openssh octal', decodePeerStderr(octalFromSsh).trim(), 'ssh: Could not resolve hostname x.invalid: 不知道这样的主机。')
check('stderr keeps unparsable escapes', decodePeerStderr(String.raw`x \777\777`), String.raw`x \777\777`)
check('stderr accepts string input', decodePeerStderr('plain ascii'), 'plain ascii')
const dirty = Buffer.concat([Buffer.from('a\u0000b\u0007c', 'utf8'), gbk])
check('stderr strips control chars', decodePeerStderr(dirty).includes('\u0000'), false)
let binaryOk = true
try {
  decodePeerStderr(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]))
} catch {
  binaryOk = false
}
check('stderr never throws on binary', binaryOk, true)

// --- diagnostic rendering and byte cap ----------------------------------
const big = renderDiagnostic({
  endpoint: 'ssh:example-host:/srv/work',
  cwd: '/srv/work',
  stopReason: 'completed',
  durationMs: 1234,
  remoteSessionId: 'session-x',
  toolCalls: [{ title: 'bash' }, { title: 'read' }],
  permissionLog: [{ decision: 'allow', tool: 'read', reason: 'read-only tool read' }],
  preAuth: { granted: true, reason: 'in-turn approval outcome: allowed-once' },
  usage: [{ used: 10, size: 100 }],
  stderrTail: ['line1', 'line2'],
  stdoutNoise: ['noise'],
})
check('diagnostic includes endpoint', /\[dsh-subagent-remote\] ssh:example-host:\/srv\/work/.test(big), true)
check('diagnostic includes stopReason', /stopReason=completed/.test(big), true)
check('diagnostic includes preAuth', /preAuth=granted/.test(big), true)
check('diagnostic hides raw stderr by default', /stderrTail=/.test(big), false)
check('diagnostic hides raw noise by default', /stdoutNoise=/.test(big), false)

const bigDebug = renderDiagnostic({
  endpoint: 'ssh:example-host:/srv/work',
  cwd: '/srv/work',
  stopReason: 'error',
  durationMs: 5,
  debug: true,
  error: 'boom: raw detail',
  stderrTail: ['line1'],
  stdoutNoise: ['noise'],
  teardownError: 'teardown boom',
})
check('debug diagnostic shows raw error', /error: boom: raw detail/.test(bigDebug), true)
check('debug diagnostic shows stderr', /stderrTail=line1/.test(bigDebug), true)
check('debug diagnostic shows noise', /stdoutNoise=noise/.test(bigDebug), true)
check('debug diagnostic shows teardown error', /teardownError=teardown boom/.test(bigDebug), true)

const classifiedDiag = renderDiagnostic({
  endpoint: 'ssh:example-host:/srv/work',
  cwd: '/srv/work',
  stopReason: 'error',
  durationMs: 5,
  stage: 'prompt',
  category: 'protocol',
  hints: ['do the thing'],
})
check('diagnostic carries fixed failure facts', /failure: stage=prompt category=protocol/.test(classifiedDiag), true)
check('diagnostic carries hints', /hint: do the thing/.test(classifiedDiag), true)

const huge = renderDiagnostic({
  endpoint: 'ssh:example-host:/srv/work',
  cwd: '/srv/work',
  stopReason: 'error',
  durationMs: 1,
  debug: true,
  error: 'e'.repeat(20000),
  stderrTail: ['x'.repeat(20000)],
})
check('diagnostic is capped', Buffer.byteLength(huge, 'utf8') <= 4096, true)
check('diagnostic is truncated visibly', /\[diagnostic truncated\]/.test(huge), true)

// --- task validation before the process boundary -------------------------
check('task: single text block', validateTaskPrompt([{ type: 'text', text: 'hello' }]), 'hello')
check('task: multiple text blocks joined', validateTaskPrompt([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
expectThrow('task: empty array rejected', () => validateTaskPrompt([]), /at least one text block/)
expectThrow('task: non-array rejected', () => validateTaskPrompt('plain string'), /at least one text block/)
expectThrow('task: image block rejected', () => validateTaskPrompt([{ type: 'text', text: 'ok' }, { type: 'image', data: 'x' }]), /text blocks only \(got image\)/)
expectThrow('task: missing text rejected', () => validateTaskPrompt([{ type: 'text' }]), /text blocks only/)
expectThrow('task: all whitespace rejected', () => validateTaskPrompt([{ type: 'text', text: '  \n ' }]), /must not be empty/)

// --- credential-shaped env scrubbing ------------------------------------
check('env scrub removes API keys', scrubEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'k', SAFE_VAR: 'v' }).env, { PATH: '/bin', SAFE_VAR: 'v' })
check('env scrub reports removed names', scrubEnv({ DEEPSEEK_API_KEY: 'k', GITHUB_TOKEN: 't', MY_SECRET: 's', OK: '1' }).removed.sort(), ['DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET'])
check('env scrub keeps SSH_AUTH_SOCK', scrubEnv({ SSH_AUTH_SOCK: '/tmp/sock' }).env, { SSH_AUTH_SOCK: '/tmp/sock' })
check('env scrub drops undefined values', scrubEnv({ A: undefined, B: 'b' }).env, { B: 'b' })
check('env scrub empty env', scrubEnv({}).removed, [])

// --- fixed failure classification ---------------------------------------
check('failure categories are fixed', FAILURE_CATEGORIES.includes('protocol') && FAILURE_CATEGORIES.includes('transport'), true)
check('classify protocol violation', classifyFailureFacts({ protocolError: 'unsupported server request: item/x', failureStage: 'prompt' }), { stage: 'prompt', category: 'protocol' })
check('classify unknown server request text', classifyFailureFacts({ error: 'ACP protocol violation: unsupported server request: item/x', failureStage: 'prompt' }).category, 'protocol')
check('classify agent mismatch', classifyFailureFacts({ error: 'remote ACP peer is not the expected agent: expected "a", observed "b"', failureStage: 'initialize' }), { stage: 'initialize', category: 'protocol' })
check('classify missing ssh', classifyFailureFacts({ error: 'spawn ssh ENOENT', failureStage: 'spawn' }), { stage: 'spawn', category: 'transport' })
check('classify host key', classifyFailureFacts({ stderrTail: ['Host key verification failed.'], failureStage: 'initialize' }).category, 'host-key')
check('classify auth', classifyFailureFacts({ stderrTail: ['Permission denied (publickey).'], failureStage: 'initialize' }).category, 'auth')
check('classify dns', classifyFailureFacts({ stderrTail: ['ssh: Could not resolve hostname nope.invalid'], failureStage: 'initialize' }).category, 'dns')
check('classify remote workspace', classifyFailureFacts({ error: 'cwd must be an absolute path: x', failureStage: 'session-new' }), { stage: 'session-new', category: 'remote-workspace' })
check('classify credential', classifyFailureFacts({ stderrTail: ['MISSING_CREDENTIAL'], failureStage: 'prompt' }).category, 'credential')
check('classify prompt product error', classifyFailureFacts({ error: 'prompt failed', failureStage: 'prompt' }), { stage: 'prompt', category: 'product-error' })
check('classify unknown', classifyFailureFacts({ error: 'boom', failureStage: 'weird' }), { stage: 'weird', category: 'unknown' })
check('classify missing stage', classifyFailureFacts({ error: 'boom' }).stage, 'unknown')

// --- new host fields ------------------------------------------------------
const advanced = normalizeHosts({
  hosts: [
    { name: 'a', ssh: 'example-host', cwd: '/srv/work', env: { MOCK_ALLOWED: 'yes' }, disposeGraceMs: 2500, expectAgentName: 'deepseek-harness-acp' },
    { name: 'b', local: true, profile: 'acp', cwd: 'C:\\tmp', scrubEnv: true },
  ],
})
check('host env block', advanced[0].env, { MOCK_ALLOWED: 'yes' })
check('host disposeGraceMs', advanced[0].disposeGraceMs, 2500)
check('host expectAgentName', advanced[0].expectAgentName, 'deepseek-harness-acp')
check('ssh scrubEnv defaults on', advanced[0].scrubEnv, true)
check('local scrubEnv explicit on', advanced[1].scrubEnv, true)
check('local scrubEnv defaults off', normalizeHosts({ local: true, cwd: 'C:\\tmp' })[0].scrubEnv, false)
expectThrow('bad env block', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', env: 'X=1' }), /must be an object of string values/)
expectThrow('bad env value', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', env: { A: 1 } }), /env\.A must be a string/)
expectThrow('bad disposeGraceMs', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', disposeGraceMs: 0 }), /disposeGraceMs must be a positive/)
expectThrow('disposeGraceMs too large', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', disposeGraceMs: 999999 }), /disposeGraceMs must be a positive/)
expectThrow('bad scrubEnv', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', scrubEnv: 'yes' }), /scrubEnv must be a boolean/)
expectThrow('bad expectAgentName', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', expectAgentName: 7 }), /expectAgentName must be a non-empty string/)

// --- widened env scrub (security review F-09) -----------------------------
check(
  'scrub removes generic credential names',
  scrubEnv({ FOO_KEY: 'k', BAR_AUTH: 'a', SESSION_ID: 's', COOKIE_JAR: 'c', DATABASE_URL: 'd', SSH_AUTH_SOCK: '/sock', PATH: '/bin' }).env,
  { SSH_AUTH_SOCK: '/sock', PATH: '/bin' },
)
check(
  'scrub reports widened names',
  scrubEnv({ FOO_KEY: 'k', DATABASE_URL: 'd' }).removed.sort(),
  ['DATABASE_URL', 'FOO_KEY'],
)

// --- ssh destination / option-injection validation (F-11) ----------------
expectThrow('ssh destination rejects option injection', () => normalizeHosts({ ssh: '-oProxyCommand=calc', cwd: '/srv/work' }), /must not start with a dash/)
expectThrow('ssh destination rejects whitespace', () => normalizeHosts({ ssh: 'host name', cwd: '/srv/work' }), /whitespace or control/)
expectThrow('sshArgs rejects ProxyCommand', () => normalizeHosts({ ssh: 'example-host', cwd: '/srv/work', sshArgs: ['-o', 'ProxyCommand=calc'] }), /must not set/)

// --- local dsh resolution never relies on a hardcoded author path (F-01) --
if (process.platform === 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-local-shim-'))
  const oldPath = process.env.PATH
  const oldShim = process.env.DSH_CLI_SHIM
  const oldBin = process.env.DSH_BIN
  try {
    writeFileSync(join(dir, 'dsh.cmd'), '@echo off\r\n"C:\\Program Files\\X\\X.exe" "%~dp0app.asar\\cli.js" %*\r\n')
    process.env.PATH = dir
    delete process.env.DSH_CLI_SHIM
    delete process.env.DSH_BIN
    const resolved = resolveLocalDsh()
    check('resolveLocalDsh finds dsh.cmd on PATH', /X\.exe$/.test(String(resolved?.command)), true)
    check('resolveLocalDsh returns the asar cli arg', /app\.asar.*cli\.js$/.test(String(resolved?.args?.[1])), true)
  } finally {
    process.env.PATH = oldPath
    if (oldShim === undefined) delete process.env.DSH_CLI_SHIM
    else process.env.DSH_CLI_SHIM = oldShim
    if (oldBin === undefined) delete process.env.DSH_BIN
    else process.env.DSH_BIN = oldBin
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failed === 0 ? '\nPASS config-selftest' : `\nFAIL config-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)





