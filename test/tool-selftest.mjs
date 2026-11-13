#!/usr/bin/env node
/**
 * Deterministic unit test for the V2 unified delegation tool.
 *
 *   node plugin/test/tool-selftest.mjs
 *   exit 0 = all checks passed
 *
 * No DSH process: the tool definition is built and executed against a fake
 * Cordis context so CI can cover the host→provider mapping and validation.
 */
import { buildUnifiedRemoteTool, registerUnifiedTool } from '../lib/tool.js'

let failed = 0
function checkTrue(name, value, detail) {
  if (value !== true) { failed += 1; console.error(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`) }
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed += 1
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

const hosts = [
  { name: 'host-a', provider: 'remote-host-a', mode: 'ssh', sshHost: 'example-host', cwd: '/srv/work' },
  { name: 'mac', provider: 'remote-mac', mode: 'ssh', sshHost: 'example-host', cwd: '/home/user' },
]

const starts = []
const ctx = {
  subagents: {
    async startActivation(spec) {
      starts.push(spec)
      return { childId: `child-${starts.length}` }
    },
  },
  tools: {
    registered: [],
    register(definition) {
      this.registered.push(definition)
      return () => {}
    },
  },
}

const call = async (definition, args, exec = { agent: { id: 'parent-1' }, signal: AbortSignal.timeout(5000) }) => {
  return definition.execute(args, exec)
}

// --- definition shape -----------------------------------------------------
const definition = buildUnifiedRemoteTool({ ctx, hosts, toolConfig: { name: 'remote_subagent' } })
check('tool name', definition.name, 'remote_subagent')
check('host enum', definition.parameters.properties.host.enum, ['host-a', 'mac'])
check('required fields', definition.parameters.required, ['description', 'prompt'])
check('description mentions hosts', /host-a/.test(definition.description) && /mac/.test(definition.description), true)
checkTrue('description explains when to use', /Use this when/.test(definition.description), definition.description)
checkTrue('description prefers the plugin over local ssh', /prefer it over ad-hoc local ssh/.test(definition.description), definition.description)
checkTrue('description says how to wait', /end the turn/.test(definition.description), definition.description)
checkTrue('description forbids follow-ups', /no send_message/.test(definition.description), definition.description)
const describedDefinition = buildUnifiedRemoteTool({
  ctx,
  hosts: [{ ...hosts[0], description: 'Windows 11 workstation' }],
  toolConfig: { name: 'remote_subagent' },
})
checkTrue('description carries host capability', /Windows 11 workstation/.test(describedDefinition.description), describedDefinition.description)
check('render shape', definition.output.render({}, { kind: 'activation', subagentId: 'x' }), [{ type: 'text', text: 'started subagent x' }])
check('concurrency safe', definition.isConcurrencySafe(), true)

// --- execute dispatch -----------------------------------------------------
const hostAResult = await call(definition, { host: 'host-a', description: 'probe', prompt: 'uname -a' })
check('host-a activation id', hostAResult, { kind: 'activation', subagentId: 'child-1' })
check('provider mapped', starts[0].provider, 'remote-host-a')
check('label prefixes the host (catalog row title)', starts[0].label, '[host-a] probe')
check('prompt block', starts[0].prompt, [{ type: 'text', text: 'uname -a' }])
check('parent passed', starts[0].parent.id, 'parent-1')
check('delivery parent', starts[0].delivery, 'parent')
check('no childId requested', starts[0].childId, undefined)
check('no maxDepth requested', starts[0].maxDepth, undefined)
// Omitted cwd must be the HOST workspace, never the parent session's directory:
// the manager would otherwise inject a local absolute path, and two POSIX machines
// (macOS parent, Linux remote) are indistinguishable by path shape. A live
// Mac->Linux dispatch failed exactly this way with `session/prompt failed`.
check('default cwd is the host workspace', starts[0].cwd, '/srv/work')
check('default cwd is not the parent session directory', starts[0].cwd === '/Users/zhaoxingchen/x', false)
// Host contract: SubagentActivationSpec extends SubagentStartRequest, so the fields are
// flat. A nested `request` wrapper made the real Host read `spec.parent.id` of undefined.
check('spec is flat (no request wrapper)', starts[0].request, undefined)
checkTrue('abort signal forwarded', starts[0].signal instanceof AbortSignal, String(starts[0].signal))

const macResult = await call(definition, { host: 'mac', description: 'probe', prompt: 'sw_vers', cwd: '/tmp' })
check('mac activation id', macResult.subagentId, 'child-2')
check('mac provider mapped', starts[1].provider, 'remote-mac')
check('explicit cwd wins over the host workspace', starts[1].cwd, '/tmp')

// --- default host resolution (host omitted) -------------------------------
const resolving = buildUnifiedRemoteTool({
  ctx,
  hosts,
  toolConfig: { name: 'remote_subagent' },
  resolveHost: (parent) => (parent?.session?.id === 'sess-mac' ? 'mac' : undefined),
})
const defaultResult = await call(resolving, { description: 'no host', prompt: 'x' }, {
  agent: { id: 'parent-2', session: { id: 'sess-mac' } },
  signal: AbortSignal.timeout(5000),
})
check('omitted host uses resolver', defaultResult.kind, 'activation')
check('resolver picked mac provider', starts[starts.length - 1].provider, 'remote-mac')
try {
  await call(resolving, { description: 'no host', prompt: 'x' }, {
    agent: { id: 'parent-3', session: { id: 'sess-other' } },
    signal: AbortSignal.timeout(5000),
  })
  check('omitted host without default rejected', false, true)
} catch (error) {
  check('omitted host error names hosts', /no host selected/.test(error.message), true)
}

// --- validation -----------------------------------------------------------
try {
  await call(definition, { host: 'windows', description: 'x', prompt: 'y' })
  check('unknown host rejected', false, true)
} catch (error) {
  check('unknown host message', /unknown remote host/.test(error.message), true)
}

try {
  await call(definition, { host: 'host-a', description: 'x', prompt: 'y' }, { signal: AbortSignal.timeout(1000) })
  check('missing agent rejected', false, true)
} catch (error) {
  check('missing agent message', /calling agent/.test(error.message), true)
}

// --- register wrapper -----------------------------------------------------
const registeredName = registerUnifiedTool(ctx, hosts, { name: 'remote_subagent' }, () => 'host-a')
check('register returns name', registeredName, 'remote_subagent')
check('register pushed one definition', ctx.tools.registered.length, 1)
check('register ignored when tool config absent', registerUnifiedTool(ctx, hosts, undefined), undefined)
check('register did not push for absent config', ctx.tools.registered.length, 1)

// --- custom tool name / description --------------------------------------
const custom = buildUnifiedRemoteTool({ ctx, hosts, toolConfig: { name: 'delegate_remote', description: 'custom text' } })
check('custom name', custom.name, 'delegate_remote')
check('custom description', custom.description, 'custom text')

console.log(failed === 0 ? '\nPASS tool-selftest' : `\nFAIL tool-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)



