/**
 * Unified multi-host delegation tool.
 *
 * V1 mounted one official `@deepseek-ai/dsh-tool-subagent` row per host (each
 * row hard-codes one provider). V2 registers ONE model-facing tool whose `host`
 * parameter selects the provider, so adding a machine is a config change, not a
 * new tool row.
 *
 * The tool speaks the same activation contract as the official delegation tool:
 * it starts an out-of-process activation with `delivery: 'parent'` and returns
 * `started subagent <id>`; the runtime sends the completion notice. No start
 * features (agentOptions/outputSchema/maxDepth/childId) are requested, matching
 * the external provider's advertised capabilities.
 *
 * Note: this file deliberately imports nothing from the DSH installation — the
 * plugin must stay loadable from an arbitrary path.
 */

/**
 * Build the tool definition for one set of hosts.
 * @param {object} parts
 * @param {object} parts.ctx Cordis plugin context (has tools/subagents)
 * @param {object[]} parts.hosts normalized host descriptors
 * @param {object} parts.toolConfig { name?, description? }
 * @param {(parent: object) => string|undefined} [parts.resolveHost] session/persisted default resolver
 * @returns {object} registry-ready tool definition
 */
export function buildUnifiedRemoteTool(parts) {
  const { ctx, hosts, toolConfig } = parts
  const resolveHost = typeof parts.resolveHost === 'function' ? parts.resolveHost : () => undefined
  const names = hosts.map((host) => host.name)
  const byName = new Map(hosts.map((host) => [host.name, host]))
  const name = typeof toolConfig.name === 'string' && toolConfig.name.length > 0
    ? toolConfig.name
    : 'remote_subagent'

  const hostBrief = hosts.map((host) => {
    const description = typeof host.description === 'string' && host.description.length > 0
      ? `: ${host.description}`
      : (host.remoteShell === 'cmd' ? ': Windows' : '')
    return `${host.name}${description}`
  }).join(', ')
  const description = typeof toolConfig.description === 'string' && toolConfig.description.length > 0
    ? toolConfig.description
    : `Delegate one one-shot task to a remote DSH host (${hostBrief}). Use this when the task needs another machine's OS, shell, tools, workspace, files, models, or credentials, when the user names one of these hosts, or when the local session cannot satisfy the request; prefer it over ad-hoc local ssh/bash commands to these hosts (permission policy, diagnostics and the session-header run indicator live here); do not use it for work the local machine can do. The target machine runs its own DSH runtime and cannot see this conversation, so include every fact it needs. This backend does not accept follow-up messages (no send_message). After dispatching, do not poll (no list_agents/job_list), sleep, or start unrelated work just to wait: end the turn and wait for the runtime completion notice. Omit "host" to use the session-selected default host (switch it with /remote-host <name> or the settings page).`

  return {
    name,
    description,
    // Raw registry definitions take standard JSON Schema here (the official
    // defineTool helper compiles the same shape from a property map).
    parameters: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          enum: names,
          description: `Target remote host name. Omit to use the selected/default host (${names.join(', ')}).`,
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'Self-contained task for the remote DSH. It cannot see this conversation, so include every fact and constraint it needs.',
        },
        cwd: {
          type: 'string',
          description: 'Optional absolute workspace path on the remote host. Omit to use the host default.',
        },
      },
      required: ['description', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
        required: ['kind', 'subagentId'],
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${name} requires a calling agent (exec.agent was undefined)`)
      const requestedHost = args.host === undefined ? resolveHost(parent) : args.host
      if (requestedHost === undefined) {
        throw new Error(`${name}: no host selected (configured: ${names.join(', ')}); pass "host" or set a default with /remote-host <name>`)
      }
      const host = byName.get(requestedHost)
      if (host === undefined) throw new Error(`${name}: unknown remote host "${String(requestedHost)}" (configured: ${names.join(', ')})`)
      exec.signal.throwIfAborted()
      const request = {
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      }
      const activation = await ctx.subagents.startActivation({
        provider: host.provider,
        label: args.description,
        request,
        signal: exec.signal,
        delivery: 'parent',
      })
      return { kind: 'activation', subagentId: activation.childId }
    },
  }
}

/**
 * Register the unified tool when the plugin config opts in (`tool:` present).
 * @param {object} ctx Cordis plugin context
 * @param {object[]} hosts normalized host descriptors
 * @param {{name?: string, description?: string}|undefined} toolConfig
 * @param {(parent: object) => string|undefined} [resolveHost] session/persisted default resolver
 * @returns {string|undefined} the registered tool name
 */
export function registerUnifiedTool(ctx, hosts, toolConfig, resolveHost) {
  if (toolConfig === undefined || toolConfig === null) return undefined
  const definition = buildUnifiedRemoteTool({ ctx, hosts, toolConfig, resolveHost })
  ctx.tools.register(definition)
  return definition.name
}




