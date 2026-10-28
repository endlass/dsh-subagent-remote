# dsh-subagent-remote

<img src="assets/icon-128.png" width="88" align="right" alt="dsh-subagent-remote icon" />

[中文](README.zh.md) | English

Cross-machine (remote) subagent provider for DeepSeek Harness (DSH). A delegation
issued from a local DSH session runs one **one-shot** subagent task on a DSH `acp`
profile living on another machine, over SSH, and returns that remote agent's
closing message to the local parent session.

> Release candidate: `0.9.2-rc.2`, verified on DSH **0.2.1-rc.2** (Windows desktop
> parent → a Linux host, a macOS host, and a local `acp` profile). Private
> repository; not published to npm.

## Screenshots

| Plugins page (installed plugin) | Configuration page | Host editor |
|---|---|---|
| ![Plugins page](assets/screenshots/market-plugins.png) | ![Configuration](assets/screenshots/config-hosts.png) | ![Editor](assets/screenshots/config-edit.png) |

## Positioning vs the official "remote & mobile" roadmap

Official DSH is working on **remote and mobile access**: reaching *the same* local
session from another device. This plugin solves a different problem: **cross-machine
compute delegation**. The parent session stays on the local machine, and a
different machine's own DSH runtime (its tools, workspace, model, SSH target)
executes a one-shot task. Nothing about the local session is migrated or exposed
over the network by this plugin.

That distinction matters when choosing between them: use official remote access to
continue *your* session elsewhere; use this plugin to run work on *another* machine's
DSH (cloud Linux box, a Mac with GUI apps, a colleague's build machine) and bring
back only the closing message.

## Why

DSH's official out-of-process ACP subagent backend is deliberately local-only:
`session/new.cwd` is the local working directory and there is no remote workspace
mapping. This plugin supplies that missing transport: it starts the remote DSH
itself and sets the ACP session workspace to a **remote absolute path**, so the
remote agent uses its own machine's tools, sandbox, model, and credentials while
the local Lead session never moves.

This is not a shared workspace and not a remote IDE session: the remote side is
one subagent activation of the local conversation.

## How it works

```text
local DSH parent (Lead session stays local)
  └─ model calls the delegation tool (`<toolName>` with a `host` argument, or one
     official `@deepseek-ai/dsh-tool-subagent` row per host in legacy mode)
       └─ dsh-subagent-remote registers one out-of-process provider per host
            └─ ssh <host> -- sh -c 'exec <remote dsh> --profile acp'
                 initialize → session/new{cwd: remote path} → session/prompt
                 → session/update* → (session/request_permission → local policy)
                 → closing message → session/close → teardown
```

The plugin is a **zero-dependency ESM Cordis plugin**: `index.js` + `lib/acp.js`
(transport), `lib/policy.js` (permission), `lib/tool.js` (V2 unified tool).

## Two ways to expose delegation to the model

### V2 unified tool (recommended)

One model-facing tool with a `host` parameter; adding a machine is a config
change, not a new tool row:

```yaml
- id: subagent-remote
  name: dsh-subagent-remote
  config:
    tool:
      name: remote_subagent            # optional, default remote_subagent
      description: 'optional custom description'   # optional
    hosts:
      - name: host-a                  # the value the model passes as host
        provider: remote-host-a       # registered subagent provider name
        ssh: example-host
        cwd: /srv/work
        permission: read-only
        timeoutMs: 180000
      - name: mac
        provider: remote-mac
        ssh: example-host
        cwd: /home/user
        permission: ask
        remoteCommand: ssh
        remoteArgs: ['-T', '-p', '2222', 'user@127.0.0.1', '<mac dsh command>']
```

### Legacy: one official tool row per host

Useful when the strict official tool wording/schema is preferred:

```yaml
- insert:
    - id: subagent-remote
      name: dsh-subagent-remote
      config:
        hosts:
          - name: host-a
            provider: remote-host-a
            ssh: example-host
            cwd: /srv/work
            permission: read-only
    - id: tool-remote-host-a
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: remote-host-a
        toolName: remote_host_a
        maxDepth: provider-managed
```

## Install

**Desktop / Web (official plugin manager, recommended):** open **插件 → 添加插件**,
enter the npm package name `dsh-subagent-remote` and confirm. It appears under
**已安装插件**; open it and use **打开配置**.

CLI alternative (for a specific profile):

```powershell
dsh plugin --profile <profile> add dsh-subagent-remote
# development from a local checkout:
dsh plugin --profile <profile> add "link:C:\path\to\dsh-subagent-remote"
```

Then start the profile (`dsh <profile> --port <n> --no-open`). The bundle patch inserts
one row with no hosts; open **插件 → dsh-subagent-remote** and add the target machines.
The plugin row still works path-loaded from a profile patch (dev workflow), but the
config page only exists for bundle installs. A fresh bundle install starts empty, so
nothing is dispatched until you add and enable a host.

### Compatibility

| Plugin | DSH | Status |
|---|---|---|
| 0.9.2-rc.4 | `0.2.1-rc.3` | verified (desktop Windows host; Linux/macOS targets) |
| 0.9.2-rc.4 | `0.2.1-rc.2` | verified |

The package declares its DSH window in `dsh.compatibility`; the plugin manager
refuses incompatible combinations and the UI is defensive about optional client
services (see `SECURITY.md` / roadmap notes).
### Development: path-loaded overlay

The package can also be mounted directly from a checkout without a bundle install
(useful while iterating on the plugin itself). Point the insert row at this
folder's `index.js`; a relative `name` is resolved against the patch file:

```yaml
- insert:
    - id: subagent-remote
      name: ../path/to/dsh-subagent-remote/index.js
      config: { ... }
```

Then `dsh --profile headless --patch <patch> "…"`. The Plugins-page configuration
UI only exists for bundle installs.

### Host fields

| Field | Default | Meaning |
|---|---|---|
| `name` | `host<N>` | label the model passes (unified tool) and used in diagnostics |
| `provider` | `remote-<name>` | registered subagent provider name |
| `ssh` | — | SSH destination (`~/.ssh/config` alias, `user@host`, or a relay host); must not start with `-` or contain whitespace |
| `cwd` | — | remote absolute workspace passed to `session/new` |
| `permission` | `read-only` | `read-only` / `ask` / `deny` / `auto` (see below) |
| `remoteSession` | `close` | `close` sends ACP `session/close` before teardown; `keep` skips it so the target keeps the persisted session history (ACP has no delete API, so nothing is removed) |
| `timeoutMs` | `600000` | prompt budget; on expiry the run is cancelled |
| `sshArgs` | `[]` | extra ssh options |
| `remoteCommand` | `dsh` | remote executable; an app-bundle install needs an absolute path + env wrapper |
| `remoteArgs` | `['--profile','acp']` | remote arguments |
| `profile` / `local` / `localCommand` / `localArgs` | — | run a local `dsh --profile acp` instead of SSH |
| `spawnCwd` | — | local cwd for the ssh/dsh child (defaults to the harness cwd) |
| `scrubEnv` | `true` for SSH, `false` for local | remove credential-shaped variables (`*_API_KEY`, `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_AUTH`, `*_COOKIE`, `*_SESSION`, `*_DSN`, `DATABASE_URL`, …) from the child environment before spawning; `SSH_AUTH_SOCK` is kept for agent forwarding. A local DSH peer usually needs the parent's provider env, so scrubbing is opt-in there |
| `env` | `{}` | explicit variables layered **after** scrubbing (an intentional escape hatch). In SSH mode these are only forwarded if the remote `sshd` accepts them (`SendEnv`); local mode passes them directly |
| `disposeGraceMs` | `5000` local / `10000` SSH | teardown grace per termination tier; capped at `60000` |
| `expectAgentName` | — | fail the run during `initialize` when the peer's `agentInfo.name` differs (identity/version gate); the observed name is always reported as `agent=` in the diagnostic |

### Relay to a machine the workstation cannot authenticate to

If host A can ssh to host B but the workstation's key is not authorized on B, use
A as the SSH endpoint and run a nested ssh as the remote command:

```yaml
- name: mac
  provider: remote-mac
  ssh: example-host
  cwd: /home/user
  remoteCommand: ssh
  remoteArgs:
    - '-T'
    - '-p'
    - '2222'
    - user@127.0.0.1
    - 'ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" --profile acp'
```

### Local mode (no SSH)

`local: true` runs a second DSH `acp` profile **on this machine** instead of over
SSH. Useful to exercise the same delegation path without a network, and on a
machine whose DSH is only reachable as an app-bundled binary:

```yaml
- name: local-dsh
  provider: remote-local
  local: true
  profile: acp
  cwd: C:/Users/me/workspace        # absolute; the parent's cwd wins when it is an absolute path
  permission: read-only
# optional: localCommand: C:/path/to/dsh.cmd   (explicit launcher wins over auto-detection)
```

Verified: the local child reports the local hostname and the parent workspace;
`stopReason=completed`; the model-listing line the ACP profile prints to stdout is
tolerated as `stdoutNoise`.

## Installed-plugin page (Web/Desktop) and JSON overlay

In the Web or DSH Desktop UI, **远端子智能体** appears on the **插件 (Plugins)**
page as a card; opening it shows the full configuration page. This is the official
placement for per-plugin configuration (`plugins.item` slot, the same surface the
official subagent/shell settings pages use). The page is a small module-loader
bundle plus a Host `/api/dsh-subagent-remote` RPC — no official client packages are
required:

- lists the effective hosts (name, endpoint, workspace, permission, remote-session
  policy, env-scrub state, which one is the default);
- **设为默认** persists the default host (applies immediately, including to tools
  that omit `host`);
- **测试连接** runs a real `ssh -T -o BatchMode=yes -o ConnectTimeout=10 <host> -- echo ok`
  probe with a 25 s per-attempt timeout and one automatic retry (spawned with
  `stdin: 'ignore'`; local peers report immediately). Slow or transient SSH
  handshakes no longer surface as a misleading failure;
- **编辑** writes the field overrides to the plugin's own JSON overlay and
  **恢复 YAML 值** removes them again;
- **添加主机** appends a new host to the overlay; the page header shows a live `当前 N 台主机，默认 X` status line;
- **禁用** takes a host offline without deleting its baseline definition (the card
  stays visible, marked 已禁用; **启用** brings it back). Overlay-added hosts also
  offer **删除**; a YAML host cannot be deleted — only disabled — because the
  profile patch stays the single source of truth.

Every write from this page is applied **immediately (hot reload)**: the plugin
disposes/re-registers the affected `ctx.subagents.registerProvider` effects (the
subagent seam is effect-scoped and HMR safe — removing a provider only blocks new
starts, it does not revoke runs already returned). The card shows a transient
"已生效：更新 …" badge, and no restart is needed. Editing the JSON file directly
by hand is picked up on the next restart; the page then shows a "检测到外部文件
改动，重启后生效" banner instead.

The overlay is `$DSH_HOME/subagent-remote.json` (atomic temp+rename writes). It is
a **delta on top of the profile patch**, never an edit of the patch itself:

```jsonc
{
  "defaultHost": "mac",
  "hosts": {
    "host-a": { "permission": "ask", "cwd": "/srv/work" },
    "extra":   { "ssh": "user@host", "cwd": "/home/user", "remoteSession": "keep" }
  }
}
```

Resolution order when a delegation omits `host`: session selection
(`/remote-host <name>`) → overlay `defaultHost` → profile `defaultHost` → the only
configured host. Both the default selection and host **definitions** edited from
the page are live: the next delegation uses the new values (no restart). Headless
and ACP deployments have no `connection`/`commands` services: the plugin still
loads and dispatch works, only the UI surfaces are absent.

The same switcher is available conversationally:

```text
/remote-host            # list hosts and mark the current one
/remote-host mac        # use mac for this session
/remote-host reset      # clear the session selection
```

## Permission model

ACP asks the client (`session/request_permission`) before a remote tool call that
needs approval. DSH's ACP server sends only the tool-call id, so this plugin
correlates the prompt with the preceding `tool_call` update and classifies the
tool by name/arguments (DSH's ACP `kind` is always `other`).

| Mode | read-only remote tools | write/execute remote tools |
|---|---|---|
| `read-only` (default) | allowed | denied; diagnostic records the reason |
| `ask` | allowed | one **in-turn** run-scoped approval at dispatch; granted → allowed, otherwise denied |
| `deny` | denied | denied |
| `auto` | allowed | allowed (explicit opt-in; documented risk) |

Why `ask` approves at dispatch: DSH's approval seam (`ctx.approval.request`) is
turn-enclosed, and a remote subagent run outlives the delegating turn. A
permission prompt that arrives after the turn ended cannot reach a human, so a
per-tool prompt would always fail closed. The plugin therefore asks once, while
the turn is still open, for authorization of the whole run; if nobody can answer
(headless, approval disabled), the run starts **not granted** and every risky
remote tool call is refused. Fail-closed is the only outcome without an answer.

**`read-only` is a heuristic, not a security boundary.** The classification is
based on the peer-reported tool `title` plus a conservative shell write-pattern
scan; a malicious or compromised peer can mislabel tools, and the scan does not
catch everything (redirection, `python -c`, `curl -X POST`, nested `ssh`, …).
The allowlist also includes network tools (`web_fetch`) and `env`. For untrusted
targets use `deny` or a remote sandbox; treat the remote closing message as
**untrusted input** to the parent model (it is not provenance-wrapped).

## Failure behavior

* The task is validated **before** any process is spawned: text blocks only, at
  least one non-blank block. Anything else settles as `invalid-request` instead of
  making the remote answer a different question.
* Spawn/SSH/initialize/session failures settle the subagent as `error` with fixed
  failure facts and canned hints; the parent keeps running.
* Protocol integrity is fail-closed: an unknown server request, or a
  `session/update` naming a different session, fails the whole run (the peer is
  answered/cancelled first, then torn down) instead of being ignored.
* A remote turn that ends `cancelled` (the peer stopped it, not this client) is
  reported as `aborted`, so a partial answer is never mistaken for a completion.
* Timeout or parent cancellation sends `session/cancel`, waits a bounded grace
  period (`disposeGraceMs`), then closes the session and kills the transport
  (`taskkill /T` on Windows, `SIGTERM`/`SIGKILL` elsewhere), then reaps the remote
  pid if the SSH handshake captured one.
* Non-JSON lines on the peer's stdout are tolerated and counted; the raw lines are
  debug-only (see below).
* The remote workspace path: the manager always injects the parent's absolute
  cwd. For SSH hosts the plugin uses it only when it is a POSIX path; otherwise it
  falls back to the host's `cwd`. (Without this, a Windows parent's
  `C:\…` path fails the remote `session/new`.)
* The diagnostic also carries `peerExit` (code/signal/pid) on failures, so a dead
  transport is distinguishable from a remote task failure.

## Diagnostics

Failures are reported with **fixed facts first**: `failure: stage=… category=…`
(stages: `dispatch`/`spawn`/`initialize`/`session-new`/`prompt`; categories:
`invalid-request`/`protocol`/`transport`/`auth`/`host-key`/`dns`/`remote-workspace`/
`credential`/`product-error`/`invalid-result`/`process`/`teardown`/`unknown`),
plus canned hints, permission decisions, `agent=name/version`, `envScrubbed`,
`peerExit`. Raw error text, stderr tail and stdout noise are **debug-only**:

```powershell
$env:DSH_SUBAGENT_REMOTE_DEBUG = '1'   # then dispatch again; the raw payload appears
```

The remote is a different trust domain. Default diagnostics carry fixed facts,
canned hints and counters; remote-authored values that do appear (the `agent=`
name/version and tool titles in `remoteTools`) are cleaned of control characters
but should still be treated as untrusted text, like the closing message itself.
Raw stderr/stdout (which may contain remote paths or hostnames) are debug-only:
`DSH_SUBAGENT_REMOTE_DEBUG=1` puts remote text into the parent session, so do not
enable it for untrusted targets or paste it publicly. stderr is decoded defensively:
remote command stderr is UTF-8, while
Windows OpenSSH's own localized messages are GBK — and when its stderr is a pipe it
spells non-ASCII text as C octal escapes (`\262\273\326\252…`). The plugin decodes
both, so a `zh-CN` Windows error reads as 「不知道这样的主机。」 instead of octal
noise (visible in debug mode).

## Upgrade checklist

Protocol facts here were measured against DSH **0.2.1-rc.2**. After upgrading DSH
on either side:

1. `npm test` (all five files) — catches config/protocol contract drift.
2. Run one read-only delegation against each configured host (maintainers keep the
   end-to-end harness in their local checkout; it is not part of this package).
3. Check the completion notice's `agent=` line: the ACP server's `agentInfo.version`
   is **not** the DSH version, so a real version gate needs an out-of-band check
   (`ssh <host> dsh --version`); `expectAgentName` only pins the agent identity.
4. Before adding new protocol interactions: unknown frames are meant to fail, not
   to be skipped. Host-key verification follows the local ssh config; `BatchMode`
   makes an unknown key fail closed. If you add `accept-new`, you accept TOFU.

## Backend norms

This provider follows the official out-of-process backend norms: provider
capabilities all false, `result` never rejects, publish-before-return with async
settlement, fixed failure categories, credential env scrubbing, fail-closed unknown
protocol frames, and debug-only raw payloads. The deliberate difference is that our
`start()` returns immediately and settles asynchronously, because a remote ACP run
cannot be handshaked inside the publishing call.

## Tests

```powershell
# pure unit tests (no DSH, no network, no credentials) — also what CI runs
node test/policy-selftest.mjs     # permission policy
node test/tool-selftest.mjs       # unified tool definition + dispatch + default-host resolution
node test/config-selftest.mjs     # config, ssh validation, task validation, failures, diagnostics, stderr decoding, env scrub
node test/settings-selftest.mjs   # overlay merge/atomic state, host selection, RPC envelope, hot-apply payload
node test/transport-selftest.mjs  # ACP transport against a mock peer
npm run check                     # node --check on every source file
npm test                          # all five files (327 checks, ~7s)
```

The end-to-end and Playwright acceptance harnesses live in the maintainer checkout,
not in the published package (the package ships only the five offline selftests).

The transport suite spawns `test/fixtures/mock-acp-peer.mjs` (behaviour selected by
`MOCK_MODE=ok|permission|hang|noise|crash|unknown-request|session-mismatch|env`) and
asserts: normal completion, permission allow/deny/fail-closed, timeout,
AbortController cancellation, stdout noise tolerance, a crashing peer, fail-closed
unknown requests, foreign-session rejection, credential env scrubbing,
remote-session close vs keep, and expected-agent mismatch — plus an orphan audit
that every mock peer exited.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm run check && npm test`.
3. Tag and push: `git tag v0.9.2-rc.4 && git push origin main --tags` (or run the
   **publish** workflow manually).
4. `.github/workflows/publish.yml` publishes with npm provenance; pre-release
   versions go to the `next` dist-tag, releases to `latest`. It needs an
   `NPM_TOKEN` repository secret; `prepublishOnly` re-runs the checks locally.

## CI

`.github/workflows/ci.yml` is prepared for the eventual public repo (Ubuntu +
Windows, Node 22): syntax check plus all five unit test files. The Playwright
settings-UI acceptance is intentionally not part of CI (it needs a running Web UI).

## Known limits (V1/V2)

* One-shot only: no follow-up messages, no cold resume, no `list_agents`
  visibility (external activations have no local session). This is the same
  contract as the official ACP subagent backend.
* A profile-patch (YAML) host can only be disabled, never deleted from the page; an overlay-added host can be deleted. Host **definitions** still live in the profile patch: the page edits a JSON overlay
  (a delta, not a second source of truth). Page edits are hot; only a hand-edited
  JSON file needs a restart, and the page reports that state.
* Remote tasks leave a persistent DSH session on the target; the plugin reports
  its id in the diagnostic and closes it, but does not delete history.
* The read-only classification is a conservative heuristic (tool-name allowlist +
  shell write-pattern scan), not a complete static analysis.










