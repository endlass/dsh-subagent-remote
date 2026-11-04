# Changelog

All notable changes to `dsh-subagent-remote` are documented here. Versions use
semantic versioning; `-rc.N`/`-spike` suffixes are pre-release.

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
