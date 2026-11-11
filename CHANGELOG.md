# Changelog

All notable changes to `dsh-subagent-remote` are documented here. Versions use
semantic versioning; `-rc.N`/`-spike` suffixes are pre-release.

Published on npm: `0.9.2-rc.3`, `0.9.2-rc.4`, `0.9.2-rc.8` (`latest`/`next`), `0.9.2-rc.9` (`next`, 2026-11-11).
`0.9.2-rc.5`–`0.9.2-rc.7` are repository pre-releases that were **not**
published to npm; install them from a checkout (`link:`) or a locally built
bundle.

## 0.9.2-rc.10 (published on `next`)

Trusted Publishing (GitHub OIDC) 发布验证版本，无功能性变更。

- CI：`publish.yml` 支持 Trusted Publishing 双模式（仓库变量 `USE_TRUSTED_PUBLISHING=true`
  时走 GitHub OIDC，不再使用 `NPM_TOKEN`）；发布前升级 npm CLI，发布后轮询 registry 校验。
- 应用代码与 0.9.2-rc.9 相同（ACP 管道错误兜底等）。

## 0.9.2-rc.9 (published on `next`)

Transport hardening: a dying ACP peer can no longer take the DSH Host down.

- `lib/acp.js`: attach `'error'` listeners to the peer's stdin, stdout, stderr and to both
  `readline` interfaces. A peer that dies between an `alive` check and an in-flight
  `stdin.write` used to raise an unhandled `EPIPE` stream error; Node promotes that to a
  process-level `uncaughtException`, and plugins run inside the DSH Host process, so the whole
  DSH exited (2026-11-11 incident). Pending RPCs are rejected instead, and the existing exit
  handler still owns lifecycle/teardown.
- `writeFrame` now converts a synchronous stdin write failure into a descriptive error.
- Existing transport selftest (114 checks) and the full selftest suite stay green.

## 0.9.2-rc.8 (published on `latest`/`next`)

Durable run journal + orphaned-run visibility (P0 exception handling).

- `lib/journal.js`: persist a bounded run snapshot to
  `$DSH_HOME/storages/dsh-subagent-remote/runs.json` (versioned, atomic temp+rename,
  mode 0600). Begin/finish checkpoints are synchronous; progress updates are
  debounced. A missing/corrupt journal is treated as empty.
- On Host restart, records still marked `running` are recovered as **orphaned**
  (not failed): the remote machine may have completed the work, so the plugin
  surfaces them for manual reconciliation instead of silently dropping them.
  Orphaned records are retained for 7 days (normal settled runs: 10 minutes).
- Settings RPC `clearOrphaned`; the plugin page shows an "unsettled remote runs"
  banner with host/startedAt/remoteSession and a Clear button. The session-header
  indicator shows orphaned runs with an "interrupted — verify" status.
- Tests: `test/journal-selftest.mjs` (roundtrip, orphan marking, corruption,
  atomic temp cleanup, DSH_HOME path); run-registry tests cover restore/snapshot/
  clear/orphan retention.
- Still one-shot: there is no automatic retry, reconnect or resume in this
  release; the journal only makes the interruption visible and reconcilable.

## 0.9.2-rc.7 (not published)

Delegation discoverability (system prompt) + session-header remote-run indicator.

### Delegation discoverability

- Register a dynamic `tool:remote-subagent` system-prompt section
  (same order as the official `TOOL_SUBAGENT` section) with the live host list,
  platform/cwd/description/permission and when-to-use guidance; the unified tool
  description now explains when to use it and carries host capability notes. New
  sessions can choose `remote_subagent` without the user naming the plugin.
- Host config: optional `description` field (also accepted by the JSON overlay, capped
  at 500 chars) surfaced to the model in the tool description and system prompt.
- Prompt guidance also tells the model to dispatch and end the turn instead of polling
  (`list_agents`/`job_list`) or sleeping while the remote task runs; it prefers
  `remote_subagent` over ad-hoc local ssh/bash to the configured hosts so the permission
  policy, diagnostics and session-header indicator are not bypassed.
- Plugin-page switch “Auto-inject delegation hint” (`autoPrompt` in the JSON overlay,
  default on): off skips the system-prompt section while keeping the tool, host config
  and `/remote-host` available for manual reminders.

### Session-header run indicator

- Host: `lib/runs.js` in-memory run registry (running/completed/error/aborted with
  host, endpoint, cwd, permission, tool count, last tool/status, usage, result
  preview and remote session id), bounded to 64 records and ~10 minutes after settle.
- Host: `startRemoteRun()` records every delegation (including pre-spawn validation
  errors) and settles it on completion/error/abort; `parentSessionIdOf()` maps the
  provider request to the durable parent session for session-scoped display.
- Transport: `runRemoteTask()` accepts an optional `onUpdate(kind, update)` observer;
  ACP `session/update` frames stream into the registry without affecting the run.
- Settings RPC: new `runs` method (`{ sessionId }`) returns the session's records.
- Client: compact indicator registered in `conversation.session.header.actions` at
  order 30 — after the official subagent catalog (10) and background-job list (20).
  Shows host/status/elapsed; a portal-rendered detail menu lists endpoint, permission,
  tool count/last tool, result preview and error; hidden when there are no runs; polls
  the host RPC every 2 s.
- Tests: `test/runs-selftest.mjs`; `parentSessionIdOf()` cases in the config selftest;
  the `onUpdate` observer case in the transport selftest (114/114 checks).
- Verified on DSH `0.2.2-rc.1` Web UI: macOS parent → Windows remote; the indicator
  appeared after the official “N subagents” chip and showed running → done, with the
  detail menu.

## 0.9.2-rc.6

Windows remote support (cmd carrier).

- Windows OpenSSH endpoints (`hosts[].cwd` as a drive-letter path, e.g.
  `C:/Users/me/work`) now use a `cmd.exe`-safe carrier. `cmd.exe` does not honour
  POSIX single quotes and treated the POSIX pid probe's `>&2` as a real
  redirection, moving the ACP stdout stream to stderr; `remoteCommand` /
  `remoteArgs` are now handed straight to `cmd.exe` (still through `ssh`), so no
  Git Bash is required on the target.
- New optional host field `remoteShell: "posix" | "cmd"`, auto-selected from the
  configured `cwd` (drive letter → `cmd`, otherwise `posix`). It is included in the
  boot log and can be overridden for edge cases.
- `pickSessionCwd()` treats a drive-letter host workspace as authoritative: a
  POSIX parent cwd such as `/private/tmp` is no longer sent to a Windows remote
  `session/new` (which failed with `working-directory: directory does not exist`).
  Windows parent → POSIX remote keeps the previous fallback.
- Remote pid reaping is best-effort on the cmd carrier (the POSIX `$$` probe does
  not exist there); ACP itself does not need it, and teardown still closes the
  session and the ssh child.
- Verified end-to-end on DSH `0.2.2-rc.1`: macOS parent → Windows 10/11 remote over
  SSH; the remote agent executed a Windows-only PowerShell task and returned the
  closing message (~30 s, 4 `pwsh` tool calls, `permission: auto`).
- Tests: `test/transport-selftest.mjs` asserts the posix/cmd ssh carriers (argv,
  quoting, no pid probe on cmd); `test/config-selftest.mjs` covers Windows
  auto-detection, explicit override and the Windows cwd fallback.

## 0.9.2-rc.5

Packaging and display-convention alignment; **no intended runtime behaviour change**.

- `package.json`: added `engines.dsh: ">=0.2.0-rc.2 <0.3.0"` (the only compatibility
  gate) next to `engines.node`; added `./locale/*.json` and `./icon`
  (`→ ./assets/icon.png`) to `exports`; added `locale/*.json` to `files`; removed the
  dead `dsh.plugin` and `dsh.compatibility` fields (never consumed by the DSH
  0.2.1-rc.5 runtime). `dsh.client` keeps the web platform and deliberately lazy
  loading (no `immediately: true`; this is a configuration-page client), but its
  `inject` list no longer names the removed Harness Client package (see below). The
  top-level `icon` and the npm publishing fields
  (`keywords`/`license`/`author`/`repository`/`publishConfig`, no `private`) are kept
  because this is a public npm package.
- Added `locale/en.json` and `locale/zh.json` (`meta.title` / `meta.description`) so
  the Plugins page shows a real name and a one-line capability description instead of
  falling back to the package name and the old bilingual paragraph.
- `description` shortened to one Chinese sentence plus a short English clause; the
  long bilingual text it replaced already lives in the READMEs.
- `README.md` / `README.zh.md`: restructured to the shared header (`能力` /
  `安装形态` / `文件` / … / `兼容性`), added a file-responsibility table and the
  registry + local-checkout (`link:`) installation forms with activation conditions,
  refreshed compatibility to the `engines.dsh` wording (verified on DSH 0.2.1-rc.5,
  2026-11-04), and documented that the title/description/icon on the Plugins page come
  from `locale/*.json` `meta` plus the package `icon`. README.zh.md no longer claims
  the package is unpublished («尚未发布到 npm»; rc.3/rc.4 are on npm) and no longer
  points at a `test/playwright/` directory that is not in the repository (the
  Playwright acceptance harness lives in the maintainer checkout).
- `test/` stays out of the npm tarball, matching the 0.9.2-rc.2 packaging decision
  (the offline selftests stay in the repository/CI).
- `lib/client.js`: removed the guarded
  `require('@deepseek-ai/dsh-client-ui-primitives')`. The DSH 0.2.1-rc.5 client-plugin
  guidance forbids loading Harness Client packages as modules, and that package is no
  longer in the rc.5 catalog. On `0.2.1-rc.5` the rendered page is unchanged (the
  require already threw and the file's own plain-HTML controls ran); on older releases
  that still shipped the primitives the page now uses those self-contained controls
  instead — functionally equivalent, styled with the plugin's own design tokens. The
  corresponding `@deepseek-ai/dsh-client-ui-primitives` entry is gone from
  `dsh.client.inject` (inject entries only order activation; no module load).
- No changes to `index.js`, `lib/**` (apart from the client-bundle conformance fix
  above) or `test/**` logic or assertions.

## 0.9.2-rc.4

Desktop boot hotfix.

- **Fixed**: on desktop restart the client plugin failed to activate with
  `cannot get property "locale" without inject` because the `locale` service was
  dropped from `dsh.client`'s `inject` array while the apply body still read
  `ctx.locale`. Restored the declaration (the same bug made Web/Desktop boot show
  "Failed to load plugins / dsh-subagent-remote").
- Added `test/client-contract-selftest.mjs`, which statically compares every
  `ctx.<service>` access in the client bundle with the declared `inject` array, and
  wired it into `npm test` + CI. This class of failure is invisible to Node-side
  unit tests because the client bundle only runs inside the DSH client loader.
- Published `latest`/`next` tags move to 0.9.2-rc.4 so plugin-manager installs pick
  up the fix.

## 0.9.2-rc.3

Marketplace/roadmap polish.

- Verified against DSH 0.2.1-rc.3 (and rc.2); `dsh.compatibility` updated.
- Install guidance now points at the official **Plugins → 添加插件** npm-name flow.
- Added plugin icon and sanitized screenshots (official plugin page, config page,
  host editor) for the marketplace/README.
- README explains the difference from the official "remote & mobile" roadmap:
  cross-machine compute delegation, not remote access to the local session.
- Client bundle falls back to plain HTML controls when optional DSH client
  services/primitives are missing; plugin-page registration degrades to a settings
  section instead of breaking.
- Added release workflow (tag / manual dispatch) with npm provenance.

## 0.9.2-rc.2

Security hardening after an independent audit (private pre-release).

- Removed the author-machine Windows path from local DSH resolution; the launcher
  is now discovered from `DSH_CLI_SHIM`, `DSH_BIN` or `PATH` only.
- Generic examples everywhere: no personal accounts, machine topology, tunnel
  ports or author home paths in the source, README, tests or tarball.
- SSH destination validation: rejects leading `-` (option injection), whitespace
  and control characters; `ProxyCommand`/`LocalCommand`-style `sshArgs` are
  rejected.
- Credential env scrubbing widened to `*_KEY`, `*_AUTH`, `*_COOKIE`,
  `*_SESSION`, `*_DSN` and `DATABASE_URL`; `SSH_AUTH_SOCK` is preserved.
- Remote pid reaping never targets pid 1/non-positive pids; stdout noise is bounded.
- `clientInfo.version` now comes from `package.json`; the published package no
  longer ships the test directory (selftests stay in the repository/CI).
- SECURITY.md documents that `read-only` is not a security boundary, that remote
  output is untrusted, and the debug-flag/host-key caveats.
- Reproducible artifact: re-created from a clean orphan commit; tests are not part
  of the npm tarball.

## 0.9.2-rc.1

First private release candidate.

- Cross-machine one-shot delegation: local DSH parent → remote DSH `acp` profile
  over SSH (ACP v1 over stdio), closing message returned to the parent.
- Fail-closed permission policy (`read-only` heuristic, `ask` pre-authorization,
  `deny`, `auto`) and diagnostic facts with hints; raw errors debug-gated.
- Unified `remote_subagent` model tool; `host` can be omitted when a default is
  selected.
- `/remote-host` command for per-session host switching.
- Plugins-page configuration (bundle install → 已安装插件 → 打开配置 → secondary
  page), official DSH UI primitives, zh/en i18n following the DSH locale.
- JSON overlay configuration (`$DSH_HOME/subagent-remote.json`) on top of the
  profile patch; hot reload for edits made from the page; YAML hosts can be
  disabled, overlay hosts can be deleted.
- `remoteSession: close | keep` controls whether ACP `session/close` is sent
  before teardown.
- Fresh bundle installs start with zero hosts; the tool registers lazily once a
  host is added.
- 315 dependency-free unit checks (policy/tool/config/settings/transport against
  a mock ACP peer) and Playwright acceptance suites for the configuration UI.

Earlier versions (`0.3.0-spike` … `0.9.0-spike`) were internal exploration
prototypes: provider seam proof, transport hardening against the official Codex
backend norms, settings page, hot reload, bundle packaging, IM-style secondary
page + i18n, and DSH-native visual pass.
