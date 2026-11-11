# Remote Subagent — 项目约定（AGENTS.md 草案）

## 这是什么

- DSH 的**跨机远端子智能体 provider**：本地会话把一次 one-shot 子代理任务派发到远端 DSH `acp` 执行。
- 仓库：`~/dsh-src/dsh-subagent-remote`；npm 包名 `dsh-subagent-remote`（当前 0.9.x-rc 线）。
- 设计口径：**组合面留宿主，能力面走进程外**（见 `~/.dsh/dossiers/dsh/philosophy.md`）——Host 插件只做门面/适配，
  远端执行走能力载体，不把 Cordis `ctx` 代理过进程边界。

## 结构

- `index.js`（插件入口）、`lib/{acp,policy,tool,settings,runs,journal,transport,client}.js`、
  `cordis.patch.yml`（插件行）、`locale/`、`test/*-selftest.mjs`、`SECURITY.md`。

## 常用命令

- `npm run check` — 全部 `node --check` 语法检查。
- `npm test` — 全量 selftest（policy/tool/config/settings/runs/journal/transport/client-contract）。
- 单项：`npm run test:policy` / `test:tool` / `test:runs` / `test:journal` / `test:transport` / `test:client`。
- `prepublishOnly` = `check + test`，发布前必过。

## 约定

- **policy 默认值不要放宽**：白名单/权限相关改动必须带 `test:policy` 覆盖；危险能力默认拒绝。
- **状态可见、失败要响**：runs/journal 记录派发与结果，异常/远端下线要有明确报错与处理路径（当前仍在设计）。
- **凭据**：远端凭据只在本地凭据存储/配置，不进仓库、不打印。
- 契约变更同步 `SECURITY.md`/README 与 CHANGELOG。
- 跨机验收：Mac ↔ 火山云真机 one-shot 派发冒烟（含离线/超时路径）。

## 当前需求（待落地）

- 手工提醒 / 自动注入开关；派发状态在会话内可见；异常与远端下线处理（详见 dossiers 的 projects/active.md）。
