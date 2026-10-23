#!/usr/bin/env node
/**
 * Deterministic mock ACP agent ("peer") for `test/transport-selftest.mjs`.
 *
 * It speaks exactly the transport `lib/acp.js` expects: newline-delimited
 * JSON-RPC 2.0 on stdin/stdout, logs on stderr. No network, no model, no DSH
 * installation — so the transport can be exercised hermetically in CI.
 *
 * Behaviour is selected by the `MOCK_MODE` environment variable:
 *
 *   ok          two `agent_message_chunk` notifications whose text concatenates
 *               to "MOCK_REMOTE_OK", then `session/prompt` -> {stopReason:'end_turn'}
 *   permission  one `tool_call` update (title "bash", rawInput = write command),
 *               then `session/request_permission`; the client's answer is echoed
 *               back as "permission option=<optionId>" in the final text
 *   hang        never answer `session/prompt`; settle it as
 *               {stopReason:'cancelled'} only after `session/cancel`
 *   noise       print one non-JSON banner line on stdout first, then behave as ok
 *   crash       exit(3) as soon as the client sends its first frame, i.e. before
 *               the `initialize` request is answered (deterministic peer death)
 *   unknown-request
 *               send a JSON-RPC request the client does not implement
 *               (`item/weird/request`); a fail-closed client must answer with an
 *               error AND fail the whole run instead of hanging
 *   session-mismatch
 *               send one `session/update` naming a different session; a strict
 *               client must treat that as a protocol violation
 *   env         success path whose answer reports whether credential-shaped
 *               variables were scrubbed and whether explicit env arrived
 *               (`env MOCK_API_KEY=present|absent MOCK_ALLOWED=<value>`)
 *
 * Unknown modes fall back to `ok` (with a stderr warning) so a typo cannot make
 * the suite hang.
 *
 * Extra argv (e.g. the `--profile acp` appended by `buildSpawn`) is ignored.
 *
 * Diagnostics:
 *   - stderr starts with `[mock] pid=<pid> mode=<mode>`; the self-test parses the
 *     pid to prove teardown really reaped the child (no orphan processes).
 *   - a run that never finishes exits 4 after 60s (watchdog), so a broken
 *     transport cannot wedge CI forever.
 */
import { createInterface } from 'node:readline'

const SESSION_ID = 'mock-acp-session-1'
const KNOWN_MODES = new Set(['ok', 'permission', 'hang', 'noise', 'crash', 'unknown-request', 'session-mismatch', 'env'])
const RAW_MODE = String(process.env.MOCK_MODE || 'ok').toLowerCase()
const MODE = KNOWN_MODES.has(RAW_MODE) ? RAW_MODE : 'ok'

function log(event, data) {
  process.stderr.write(`[mock] ${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}\n`)
}

log(`pid=${process.pid} mode=${MODE}`)
if (MODE !== RAW_MODE) log('unknown-mode-falling-back-to-ok', { mode: RAW_MODE })

// A real DSH peer does emit stray non-JSON lines on stdout (model listing logs),
// so `noise` mode reproduces that before any protocol frame.
if (MODE === 'noise') {
  process.stdout.write('[mock] non-json banner: stdout is not pure JSON-RPC (noise mode)\n')
}

let nextServerId = 0
const pendingClientRequests = new Map()
let pendingPromptId = null

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

/**
 * Agent -> client request. Resolves with the client's full response frame.
 * Bounded so a non-answering client cannot pin the fixture forever.
 */
function requestClient(method, params) {
  nextServerId += 1
  const id = `mock-srv-${nextServerId}`
  const promise = new Promise((resolve) => {
    pendingClientRequests.set(id, resolve)
  })
  send({ jsonrpc: '2.0', id, method, params })
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve({ error: { code: -32000, message: `${method} answer timed out in fixture` } }), 20000).unref()
    }),
  ])
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('close', () => {
  log('stdin-closed')
  process.exit(0)
})
process.on('SIGTERM', () => {
  log('sigterm')
  process.exit(0)
})
const watchdog = setTimeout(() => {
  log('watchdog-timeout')
  process.exit(4)
}, 60000)
watchdog.unref()

// ------------------------------------------------------------------ handlers

function answerInitialize(message) {
  log('initialize', { protocolVersion: message.params?.protocolVersion })
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      protocolVersion: 1,
      agentInfo: { name: 'mock-acp-peer', version: '0.0.1' },
      agentCapabilities: {
        mcpCapabilities: { http: false },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    },
  })
}

function answerNewSession(message) {
  log('session/new', { cwd: message.params?.cwd, mcpServers: message.params?.mcpServers })
  send({ jsonrpc: '2.0', id: message.id, result: { sessionId: SESSION_ID, configOptions: [] } })
}

function answerCloseSession(message) {
  log('session/close', message.params)
  send({ jsonrpc: '2.0', id: message.id, result: {} })
}

function chunk(messageId, text) {
  notify('session/update', {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
  })
}

/** `ok` and `noise` success path: two chunks that concatenate to MOCK_REMOTE_OK. */
function answerSuccessPrompt(message) {
  chunk('msg-ok', 'MOCK_REMOTE_')
  chunk('msg-ok', 'OK')
  send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
}

/** permission path: tool_call update, then session/request_permission. */
async function answerPermissionPrompt(message) {
  const toolCallId = 'call-1'
  chunk('msg-permission', 'about to run a remote tool\n')
  notify('session/update', {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'rm -rf /tmp/mock-probe' },
    },
  })
  let optionId = 'client-error'
  try {
    const response = await requestClient('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    if (response?.error !== undefined) {
      log('client-error', { message: 'client answered with a JSON-RPC error', error: response.error })
      optionId = 'client-error'
    } else {
      const outcome = response?.result?.outcome
      if (outcome?.outcome === 'selected' && typeof outcome.optionId === 'string') optionId = outcome.optionId
      else if (outcome?.outcome === 'cancelled') optionId = 'cancelled'
      else {
        log('client-error', { message: 'invalid session/request_permission response', response })
        optionId = 'invalid-response'
      }
    }
  } catch (error) {
    log('permission-error', { message: String(error?.message ?? error) })
    optionId = 'permission-error'
  }
  notify('session/update', {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: optionId === 'allow-once' ? 'completed' : 'failed' },
  })
  chunk('msg-permission-final', `permission option=${optionId}\n`)
  send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
}

async function answerPrompt(message) {
  const promptText = (message.params?.prompt || []).map((block) => block?.text || '').join('')
  log('session/prompt', { text: promptText.slice(0, 80), sessionId: message.params?.sessionId })
  if (MODE === 'hang') {
    pendingPromptId = message.id
    log('hang: waiting for session/cancel')
    return
  }
  if (MODE === 'session-mismatch') {
    // A notification for another session must not be attributed to this run.
    notify('session/update', {
      sessionId: 'mock-acp-session-OTHER',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg-foreign', content: { type: 'text', text: 'FOREIGN' } },
    })
    pendingPromptId = message.id
    log('session-mismatch: sent foreign-session update, waiting for teardown')
    return
  }
  if (MODE === 'unknown-request') {
    chunk('msg-unknown', 'before unknown request\n')
    const response = await requestClient('item/weird/request', { sessionId: SESSION_ID, payload: 'x' })
    log('unknown-request-answer', { error: response?.error?.message ?? null })
    // If the client keeps running, complete normally so the suite can observe
    // that fail-closed did NOT happen.
    chunk('msg-unknown', `unknown request answered with error=${Boolean(response?.error)}\n`)
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (MODE === 'env') {
    const leaked = process.env.MOCK_API_KEY === undefined ? 'absent' : 'present'
    const allowed = process.env.MOCK_ALLOWED ?? 'absent'
    chunk('msg-env', `env MOCK_API_KEY=${leaked} MOCK_ALLOWED=${allowed}`)
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (MODE === 'permission') {
    await answerPermissionPrompt(message)
    return
  }
  answerSuccessPrompt(message)
}

function answerCancel(message) {
  log('session/cancel', message.params)
  if (pendingPromptId !== null) {
    send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } })
    pendingPromptId = null
  }
}

// -------------------------------------------------------------- message loop

async function handleLine(rawLine) {
  const line = rawLine.trim()
  if (line.length === 0) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log('client-non-json', { line: line.slice(0, 120) })
    return
  }
  // Response to one of our agent -> client requests.
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingClientRequests.get(message.id)
    if (resolve === undefined) {
      log('orphan-client-response', { id: message.id })
      return
    }
    pendingClientRequests.delete(message.id)
    resolve(message)
    return
  }
  if (message.method === 'initialize') {
    answerInitialize(message)
    return
  }
  if (message.method === 'session/new') {
    answerNewSession(message)
    return
  }
  if (message.method === 'session/prompt') {
    await answerPrompt(message)
    return
  }
  if (message.method === 'session/close') {
    answerCloseSession(message)
    return
  }
  if (message.method === 'session/cancel') {
    answerCancel(message)
    return
  }
  if (message.method === '$/cancel_request') {
    log('cancel-request', message.params)
    return
  }
  if (message.method !== undefined && message.id !== undefined) {
    log('unsupported-request', { method: message.method })
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `not implemented: ${message.method}` } })
  }
}

if (MODE === 'crash') {
  // Exit only once the client has actually spoken: the initialize request is
  // written successfully, then the peer dies, so the transport sees a real
  // "exited before answering" path instead of a spawn/write race.
  let spoke = false
  rl.once('line', (line) => {
    spoke = true
    log('crash-before-initialize', { firstLine: String(line).slice(0, 100) })
    process.exit(3)
  })
  rl.on('close', () => {
    if (!spoke) process.exit(3)
  })
} else {
  rl.on('line', (line) => {
    void handleLine(line)
  })
}
