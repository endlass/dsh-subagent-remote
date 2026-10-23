# 安全说明 / Security

## 这个插件做什么

`dsh-subagent-remote` 让本地 DSH 会话把**一次性子任务**派发到另一台机器上的
DSH `acp` profile 执行，结果（closing message）返回本地父会话。远端执行依赖本机
已有的 SSH 配置与密钥。

## 信任模型

- **远端机器是被信任的**：插件会在目标机器上运行 DSH 及其工具。只配置你控制的
  主机。
- **不内置任何主机、账号或密钥**：主机定义来自 profile patch 或插件的 JSON
  overlay；SSH 凭据完全走本机 `ssh` 配置（agent/密钥）。
- **env scrub**：SSH 模式下默认剔除形似凭证的环境变量（`*_API_KEY`、`*_KEY`、
  `*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_AUTH`、`*_COOKIE`、`*_SESSION`、
  `*_DSN`、`DATABASE_URL` 等），保留 `SSH_AUTH_SOCK` 以支持 agent forwarding；
  可通过 `scrubEnv: false` 显式关闭。显式 `env` 在 scrub 之后叠加（SSH 模式需远端
  `sshd` 允许 `SendEnv` 才会转发）。
- **主机密钥**：插件继承本机 ssh 配置；`BatchMode=yes` 让未知 host key 直接失败
  （fail closed）。若你自行加 `StrictHostKeyChecking=accept-new`，等于接受首次连接
  的 TOFU 风险，建议之后核对指纹。
- **远端会话历史**：`remoteSession: close` 只关闭 ACP 会话，不删除远端持久化历史
  （ACP 没有删除 API）。
- **权限**：远端任务的权限策略由 `permission` 决定（`read-only` / `ask` /
  `deny` / `auto`）。**`read-only` 只是防误操作的启发式，不是安全边界**：分类依赖
  peer 自报的 tool title，shell 写模式扫描也覆盖不全（重定向、`python -c`、
  `curl -X POST`、嵌套 `ssh` 等都可能漏）。对不信任的远端请用 `deny` 或远端沙箱。
- **远端输出不可信**：closing message 以及诊断里的 `agent=` / `remoteTools=` 都来自
  远端 DSH，进父会话时可能构成 prompt injection；默认诊断不携带原始 stderr/stdout，
  但 closing message 本身无法被“消毒”，请按外部输入对待。
- **调试开关**：`DSH_SUBAGENT_REMOTE_DEBUG=1` 会把远端 stderr/stdout 原文放进父会话
  可见诊断（可能含远端路径/主机名），只在你控制的机器上临时开启，不要贴到公开处。
- **无遥测**：插件不发送任何统计数据。

## 报告漏洞

仓库建立后请使用 GitHub 的 **Private vulnerability reporting / Security advisory**
私下报告，不要先开公开 issue。若仓库尚未建立，请先联系维护者。
