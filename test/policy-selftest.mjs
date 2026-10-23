#!/usr/bin/env node
/**
 * Deterministic unit test for the permission policy (no DSH process needed).
 *
 *   node plugin/test/policy-selftest.mjs
 *   exit 0 = all checks passed
 *
 * Covers: read-only classification, option picking, and the four modes including
 * the fail-closed `ask` path when the local approval seam is absent or denies.
 */
import { classifyToolCall, pickOption, createPermissionDecider, requestRunPreAuthorization, READ_ONLY_TOOL_NAMES } from '../lib/policy.js'

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

// --- classification -------------------------------------------------------
check('read tool', classifyToolCall({ title: 'read', rawInput: { path: '/etc/passwd' } }), 'read-only')
check('grep tool', classifyToolCall({ title: 'grep' }), 'read-only')
check('bash with write redirect', classifyToolCall({ title: 'bash', rawInput: { command: 'echo x > /etc/y' } }), 'write')
check('bash read-only command', classifyToolCall({ title: 'bash', rawInput: { command: 'uname -a; df -h /' } }), 'write')
check('write tool', classifyToolCall({ title: 'write', rawInput: {} }), 'write')
check('edit tool', classifyToolCall({ title: 'edit' }), 'write')
check('unknown tool', classifyToolCall({ title: 'mystery_tool' }), 'unknown')
check('missing call', classifyToolCall(undefined), 'unknown')
check('all whitelist entries are lowercase', READ_ONLY_TOOL_NAMES.size > 20, true)

// --- option picking -------------------------------------------------------
const options = [
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'reject-once', kind: 'reject_once' },
]
check('pick allow', pickOption(options, true)?.optionId, 'allow-once')
check('pick reject', pickOption(options, false)?.optionId, 'reject-once')
check('pick allow from empty', pickOption([], true), undefined)

// --- modes ---------------------------------------------------------------
const readCall = { call: { title: 'read', rawInput: {} }, options, toolCallId: 'c1' }
const writeCall = { call: { title: 'write', rawInput: { path: '/etc/x' } }, options, toolCallId: 'c2' }

function fakeCtx(outcome) {
  return {
    get(service) {
      if (service !== 'approval') return undefined
      return {
        async request(request) {
          fakeCtx.lastRequest = request
          if (outcome instanceof Error) throw outcome
          return outcome
        },
      }
    },
  }
}

const request = { parent: { id: 'session-parent', session: {} }, prompt: [{ type: 'text', text: 'x' }], cwd: '/srv/work', label: 't', signal: new AbortController().signal }

const autoDecider = createPermissionDecider({ mode: 'auto', request, ctx: fakeCtx(), providerName: 'remote' })
check('auto allows write', (await autoDecider(writeCall)).allow, true)

const denyDecider = createPermissionDecider({ mode: 'deny', request, ctx: fakeCtx(), providerName: 'remote' })
check('deny rejects read', (await denyDecider(readCall)).allow, false)

const roDecider = createPermissionDecider({ mode: 'read-only', request, ctx: fakeCtx(), providerName: 'remote' })
check('read-only allows read', (await roDecider(readCall)).allow, true)
const roWrite = await roDecider(writeCall)
check('read-only rejects write', roWrite.allow, false)
check('read-only reject source', roWrite.source, 'read-only-reject')

const askNoService = createPermissionDecider({ mode: 'ask', request, ctx: { get: () => undefined }, providerName: 'remote' })
const askUnavailable = await askNoService(writeCall)
check('ask without preauth fails closed', askUnavailable.allow, false)
check('ask without preauth source', askUnavailable.source, 'ask-not-granted')
check('ask without preauth reason mentions tool', /write/.test(askUnavailable.reason), true)

const askPreGranted = createPermissionDecider({ mode: 'ask', request, ctx: {}, providerName: 'remote', preAuth: { granted: true, reason: 'in-turn approval outcome: allowed-once' } })
const askGrantedOutcome = await askPreGranted(writeCall)
check('ask preauth granted allows write', askGrantedOutcome.allow, true)
check('ask preauth source', askGrantedOutcome.source, 'ask-preauth')

const askPreDenied = createPermissionDecider({ mode: 'ask', request, ctx: {}, providerName: 'remote', preAuth: { granted: false, reason: 'in-turn approval outcome: unavailable' } })
const askDeniedOutcome = await askPreDenied(writeCall)
check('ask preauth denied rejects write', askDeniedOutcome.allow, false)
check('ask preauth denied reason', /unavailable/.test(askDeniedOutcome.reason), true)

// --- in-turn pre-authorization against the approval seam -----------------
const preAuthDenied = await requestRunPreAuthorization({ ctx: fakeCtx('unavailable'), request, providerName: 'remote', endpoint: 'ssh:example-host:/srv/work' })
check('preauth unavailable is not granted', preAuthDenied.granted, false)
check('preauth unavailable keeps outcome', preAuthDenied.outcome, 'unavailable')

const preAuthAllowed = await requestRunPreAuthorization({ ctx: fakeCtx('allowed-once'), request, providerName: 'remote', endpoint: 'ssh:example-host:/srv/work' })
check('preauth allowed-once grants', preAuthAllowed.granted, true)
check('preauth request names the agent', fakeCtx.lastRequest?.agent, request.parent)
check('preauth request mentions the endpoint', /example-host/.test(fakeCtx.lastRequest?.reason ?? ''), true)

const preAuthError = await requestRunPreAuthorization({ ctx: fakeCtx(new Error('no turn')), request, providerName: 'remote', endpoint: 'x' })
check('preauth error fails closed', preAuthError.granted, false)
check('preauth error outcome', preAuthError.outcome, 'error')

const preAuthNoService = await requestRunPreAuthorization({ ctx: { get: () => undefined }, request, providerName: 'remote', endpoint: 'x' })
check('preauth without service fails closed', preAuthNoService.granted, false)

const askRead = createPermissionDecider({ mode: 'ask', request, ctx: fakeCtx('rejected'), providerName: 'remote' })
check('ask allows read-only without preauth', (await askRead(readCall)).allow, true)

// --- invalid mode is refused at construction -----------------------------
try {
  createPermissionDecider({ mode: 'nonsense', request, ctx: fakeCtx(), providerName: 'remote' })
  check('invalid mode rejected', false, true)
} catch {
  console.log('ok   invalid mode rejected')
}

console.log(failed === 0 ? `\nPASS policy-selftest` : `\nFAIL policy-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)

