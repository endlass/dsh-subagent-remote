# Changelog

All notable changes to `dsh-subagent-remote` are documented here. Versions use
semantic versioning; `-rc.N`/`-spike` suffixes are pre-release.

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
