# 远端子智能体（dsh-subagent-remote）

<img src="assets/icon-128.png" width="88" align="right" alt="dsh-subagent-remote icon" />

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-subagent-remote?label=npm)](https://www.npmjs.com/package/dsh-subagent-remote)
[![license](https://img.shields.io/npm/l/dsh-subagent-remote)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2%20%3C0.3.0-blue)](package.json)

跨机器（远端）子智能体 provider。本地 DSH 会话发起的一次委派，会通过 SSH 在另一台
机器上的 DSH `acp` profile 里运行**一次性**子任务，并把远端 agent 的 closing message
返回本地父会话；本地会话本身不迁移、不对外暴露。

> **版本状态**：仓库当前是 `0.9.2-rc.8`（会话顶部运行指示器 + Windows 远端 +
> **异常未结算任务可见**）。npm 上 `latest` = `0.9.2-rc.4`、`next` = `0.9.2-rc.8`；
> 装最新预发布用 `dsh-subagent-remote@next`（或精确钉 `@0.9.2-rc.8`），本地开发用 `link:`。
> 兼容窗口：`engines.dsh: ">=0.2.0-rc.2 <0.3.0"`、`engines.node: ">=22"`。已在
> DSH `0.2.1-rc.5`（Windows 桌面父会话 → 一台 Linux 主机、一台 macOS 主机、以及本地
> `acp` profile）和 DSH `0.2.2-rc.1`（macOS 父会话 → Windows 远端；Web UI 顶部指示器
> running → done）上验证。

## 目录

- [前置要求](#前置要求)
- [截图](#截图)
- [能力](#能力)
- [安装形态](#安装形态)
  - [npm registry](#npm-registry)
  - [插件页（Web/桌面）](#插件页web桌面)
  - [Bundle 安装](#bundle-安装)
  - [本地 checkout（`link:`）](#本地-checkoutlink)
  - [生效条件](#生效条件)
  - [路径加载 overlay](#路径加载-overlay)
- [文件](#文件)
- [工作原理](#工作原理)
- [配置](#配置)
- [权限模型](#权限模型)
- [失败行为](#失败行为)
- [诊断](#诊断)
- [安全与边界](#安全与边界)
- [开发与验证](#开发与验证)
- [安装 / 卸载 / 回滚](#安装--卸载--回滚)
- [已知限制（V1/V2）](#已知限制v1v2)
- [兼容性](#兼容性)
- [License](#license)

## 前置要求

| 一侧 | 要求 |
|---|---|
| 本地 Host | DSH `>=0.2.0-rc.2 <0.3.0`（桌面应用或 `dsh` CLI profile）；Node `>=22` |
| 本地 UI（可选） | Web/桌面，用于插件页、会话顶部指示器和 `/remote-host`；headless/ACP profile 没有 UI 也能派发、诊断并取回结果 |
| 远端机器 | 装有 DSH 并暴露 `acp` profile，且本地能用密钥/agent 经 SSH 连上；POSIX `sh` 或 Windows OpenSSH（`cmd.exe` 载体） |
| 远端工作区 | `cwd` 必须是远端已存在的**绝对路径** |

插件没有第三方运行时依赖（`index.js` + `lib/*`，只用 Node 内置模块）。插件不保存
SSH 凭据——凭据完全走本机 `ssh` 配置/agent；远端 DSH 的凭据留在远端机器上。

## 截图

| 插件页（已安装） | 配置页 | 主机编辑 |
|---|---|---|
| ![插件页](assets/screenshots/market-plugins.png) | ![配置页](assets/screenshots/config-hosts.png) | ![编辑](assets/screenshots/config-edit.png) |

## 能力

- **跨机一次性委派**——本地 DSH 会话把自包含任务委派给另一台机器自己的 DSH 运行时
  （用它的工具、工作区、模型与凭据），只带回远端 closing message；本地会话内容不迁移，
  也不由本插件对网络暴露。
- **Windows 远端**——主机 `cwd` 是盘符路径（如 `C:/Users/me/work`）时自动改用 cmd
  载体：远端命令直接交给 Windows OpenSSH 的 `cmd.exe`，不要求目标安装 Git Bash。远端
  pid 探测在 cmd 载体上不可用，回收降级为 best-effort（ACP 本身不依赖 pid）。
- **统一的「多主机」工具**——只暴露一个带 `host` 参数的模型工具 `remote_subagent`；
  加一台机器是改配置，不是加一行工具。也支持显式的 legacy 模式（每台主机一行
  `@deepseek-ai/dsh-tool-subagent`）。
- **fail-closed 权限策略**——`read-only`（默认启发式）、`ask`（派发时在 turn 内向人工
  申请一次整轮授权）、`deny`、`auto`；没人能回答时，需要审批的远端工具调用一律拒绝，
  绝不默认放行。
- **配置页 + 热加载**——插件页可列出主机、实测 SSH 连通性、编辑字段覆盖、设置/清除默认
  主机；页面写入落到插件自己的 JSON overlay（profile patch 之上的增量）并立即生效，无需重启。
- **会话内切换主机**——`/remote-host` 列出主机并切换当前会话使用的目标主机。
- **会话顶部运行指示器**——派发后在会话 header（官方子智能体、后台任务之后）显示远端
  主机、运行状态与耗时；完成后短暂保留耗时、工具次数与结果摘要，点击展开详情。
- **自动委托提示（system prompt）**——向每个新会话的系统提示词注册远端主机能力与使用
  时机；用户不必点名 `remote_subagent`，模型会按任务需要自行选择。插件页可关闭该注入
  （关闭后工具仍在，需在会话里手动提醒）。
- **未结算任务可见（P0）**——本机重启时仍在运行的远端任务会恢复为 `orphaned`
  （不是 failed），插件页与顶部指示器可看到主机、时间和远端 session id，方便人工核对；
  不会自动重试/续跑。
- **结构化诊断**——固定失败事实（`stage=`/`category=`）、内置提示、权限决定、`agent=`、
  env-scrub 与 peer 退出事实；远端原始文本默认只在 debug 开关下出现。
- **零依赖 ESM Cordis 插件**——`index.js` + `lib/*`，无第三方依赖，全部测试可离线跑。

## 安装形态

所有安装形态挂载同一个 DSH **bundle**：`cordis.patch.yml` 插入一行 `subagent-remote`
（默认零主机，全新安装不可能指向错误机器）；插件不保存任何 SSH 凭据（凭据走本机
`ssh` 配置/agent）。

### npm registry

把已发布版本装进 profile（`dsh plugin` 会把参数转发给 profile 目录里的 `pnpm`，
因此任何 pnpm spec 都可用）：

```bash
dsh plugin --profile <profile> add dsh-subagent-remote          # latest = 0.9.2-rc.4
dsh plugin --profile <profile> add dsh-subagent-remote@next    # 最新预发布 = 0.9.2-rc.8
# 或精确钉版本
dsh plugin --profile <profile> add dsh-subagent-remote@0.9.2-rc.8
```

npm dist-tags：`latest` = `0.9.2-rc.4`、`next` = `0.9.2-rc.8`。发布工作流把 `-rc.N`
发到 `next`，只有正式版才发 `latest`。仓库版本 `0.9.2-rc.8` 已发布到 `next`；
`0.9.2-rc.5`–`rc.7` 是仓库预发布，从未发到 npm。

### 插件页（Web/桌面）

**桌面/Web 推荐方式。** 打开 **插件 → 添加插件**，输入 `dsh-subagent-remote` 确认。
安装后出现在 **已安装插件**；点开使用 **打开配置**。插件卡片与配置页见上面的截图。

### Bundle 安装

本包是一个 DSH bundle（`dsh.bundle.patch` → `cordis.patch.yml`）。Agent 工具链与
非 UI 流程可以通过插件管理器的 `install_bundle` 动作安装，`target` 传包名/spec——
插件页的 **添加插件** 走的就是这个动作。本地构建（例如 `npm pack` 出来的 tarball）
或 catalog/bundle spec 也走这个形态。它和 CLI 一样把 patch 插进 profile；装完重启
DSH。

### 本地 checkout（`link:`）

开发时直接 link checkout（直接解析工作树，`files` 不参与）：

```bash
dsh plugin --profile <profile> add "link:/path/to/dsh-subagent-remote"
```

Windows：`dsh plugin --profile <profile> add "link:C:\path\to\dsh-subagent-remote"`。

### 生效条件

- 安装后启动 profile：`dsh <profile> --port <n> --no-open`。bundle patch 只插入一行、
  且 `config` 为空；打开 **插件 → dsh-subagent-remote**（或 **已安装插件 →
  dsh-subagent-remote → 打开配置**）添加目标机器。
- **Host 半**：插件代码由 Host 进程加载——安装、升级或任何 `index.js`/`lib/**` 改动都要
  **重启 DSH**（重启桌面应用或 profile 进程）才生效。
- **Client bundle**：只改 `lib/client.js` 时**刷新页面**即可。`dsh.client` 刻意**没有**
  `immediately: true`：这是纯配置页 client，只有在打开插件页/设置页时才按需加载，正常
  聊天启动路径不为此付出代价。它仍然声明了 web platform 和 bundle 用到的全部 `inject` 包。
- **Headless / ACP 部署**没有 `connection`/`commands` 服务：插件照常加载、委派照常可用，
  只是没有 UI 界面。
- 全新的 bundle 安装是空的：在添加并启用主机之前不会派发任何任务。
- 插件行也支持从 profile patch 路径加载（开发工作流），但配置页只对 bundle 安装存在。

### 路径加载 overlay

不安装 bundle 也可以直接从 checkout 挂载（适合迭代插件本身）：把 insert 行的 `name`
指向本目录的 `index.js`；相对 `name` 相对 patch 文件解析：

```yaml
- insert:
    - id: subagent-remote
      name: ../path/to/dsh-subagent-remote/index.js
      config: { ... }
```

然后 `dsh --profile headless --patch <patch> "…"`。插件页配置 UI 只对 bundle 安装存在。

## 文件

| 文件 / 目录 | 作用 |
|---|---|
| `package.json` | npm 清单：`exports`（`.`、`./client`、`./locale/*.json`、`./icon`、`./package.json`）、`files`、`engines.node`/`engines.dsh`、`dsh.bundle.patch` 与 `dsh.client` 段、顶层 `icon` |
| `cordis.patch.yml` | bundle patch，插入 profile；加一行 `subagent-remote` host 行且 `config` 为空（默认零主机，全新安装不可能指向错误机器） |
| `index.js` | Host 半入口：Cordis 插件，为每台主机注册一个 out-of-process 子智能体 provider、统一工具/命令，以及页面用的 `/api/dsh-subagent-remote` RPC |
| `lib/acp.js` | ACP over stdio 传输：`initialize`/`session/new`/`session/prompt`/`session/update`、权限关联、有界 teardown、远端 pid 回收 |
| `lib/policy.js` | `read-only`/`ask`/`deny`/`auto` 的权限分类与 fail-closed 决定 |
| `lib/tool.js` | 统一工具 `remote_subagent` 的定义、派发与默认主机解析 |
| `lib/settings.js` | JSON overlay 存储（原子 temp+rename 写入）、主机选择、RPC 信封与热加载 payload |
| `lib/runs.js` | 会话顶部指示器背后的内存运行注册表（上限 64 条，结束后约 10 分钟） |
| `lib/journal.js` | 持久化运行日志（`$DSH_HOME/storages/dsh-subagent-remote/runs.json`）；把 Host 重启时中断的运行恢复为 `orphaned` |
| `lib/client.js` | Client 半（Web/桌面）：插件页配置面板、设置区块降级、locale 注册；按需懒加载 |
| `locale/en.json`、`locale/zh.json` | 插件页展示元数据（`meta.title` / `meta.description`） |
| `assets/icon.png` | 插件图标（PNG，≤256 KiB），由顶层 `icon` 与 `./icon` 导出引用 |
| `assets/icon-128.png` | README 头部用的较大图标 |
| `assets/screenshots/` | README 截图（已脱敏） |
| `README.md`、`README.zh.md` | 用户文档（英文 / 中文） |
| `CHANGELOG.md` | 版本历史 |
| `SECURITY.md` | 信任模型、漏洞报告与安全边界 |
| `LICENSE` | MIT |
| `test/` | 零依赖离线 selftest 与 mock ACP peer；保留在仓库/CI，**不进入 npm tarball** |
| `.github/workflows/` | CI（Ubuntu + Windows + macOS，Node 22/24，含打包检查）与 npm 发布工作流 |

插件管理页显示的**标题、描述和图标**来自 `locale/en.json` + `locale/zh.json` 的
`meta.title` / `meta.description`，图标来自 package.json 顶层 `icon`
（`./assets/icon.png`）。没有 locale 文件时页面会回退到包 `name` 和 `description`——
下面这些长文是给人看的，真正渲染到 UI 的是 locale 文件。

## 工作原理

```text
本地 DSH 父会话（Lead 会话留在本机）
  └─ 模型调用委派工具（`<toolName>` 带 `host` 参数；legacy 模式为每台主机一行官方
     `@deepseek-ai/dsh-tool-subagent`）
       └─ dsh-subagent-remote 为每台主机注册一个 out-of-process provider
            └─ ssh <host> -- sh -c 'exec <remote dsh> --profile acp'
                 initialize → session/new{cwd: 远端路径} → session/prompt
                 → session/update* → (session/request_permission → 本地策略)
                 → closing message → session/close → teardown
```

插件是**零依赖 ESM Cordis 插件**：`index.js` + `lib/acp.js`（传输）、`lib/policy.js`
（权限）、`lib/tool.js`（V2 统一工具）。

### 为什么需要它

DSH 官方 out-of-process ACP 子智能体后端是刻意 local-only 的：`session/new.cwd` 只能是
本地工作目录，也没有远端工作区映射。本插件补的正是这段缺失的传输：它自己启动远端 DSH，
把 ACP 会话工作区设为**远端绝对路径**，于是远端 agent 用自己机器上的工具、沙箱、模型和
凭据工作，而本地 Lead 会话始终不动。

这不是共享工作区，也不是远端 IDE 会话：远端那一侧只是本地对话的一次子智能体激活。

### 与官方「远程/移动端」规划的定位区别

官方 DSH 在做**远程与移动端访问**：从别的设备访问*同一个*本地会话。本插件解决的是另一个
问题：**跨机算力委派**。父会话留在本机，另一台机器用它自己的 DSH 运行时（工具、工作区、
模型、SSH 目标）执行一次性任务；本插件不迁移、也不对外暴露本地会话的任何内容。

这个区别决定了怎么选：想在别处继续*你自己的*会话，用官方远程访问；想把活跑在*另一台
机器*的 DSH 上（云端 Linux、带 GUI 应用的 Mac、同事的构建机），只把 closing message 带回来，
用本插件。

### 两种向模型暴露委派的方式

#### V2 统一工具（推荐）

一个模型可见的工具，带 `host` 参数；加一台机器是改配置，不是加一行工具：

```yaml
- id: subagent-remote
  name: dsh-subagent-remote
  config:
    tool:
      name: remote_subagent            # 可选，默认 remote_subagent
      description: '可选的自定义描述'   # 可选
    hosts:
      - name: host-a                  # 模型作为 host 传入的值
        provider: remote-host-a       # 注册的子智能体 provider 名
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

#### Legacy：每台主机一行官方工具

偏好官方工具措辞/schema 时使用：

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

## 配置

### 主机字段

| 字段 | 默认值 | 含义 |
|---|---|---|
| `name` | `host<N>` | 模型传入的主机标签（统一工具），也用于诊断 |
| `provider` | `remote-<name>` | 注册的子智能体 provider 名 |
| `ssh` | — | SSH 目标（`~/.ssh/config` 别名、`user@host` 或中继主机）；不得以 `-` 开头、不得含空白 |
| `description` | — | 可选的一行主机能力说明（如 “Windows 11 + PowerShell”）；会进入 tool description 与系统提示词的主机清单，也支持 JSON overlay |
| `cwd` | — | 传给 `session/new` 的远端绝对工作区 |
| `permission` | `read-only` | `read-only` / `ask` / `deny` / `auto`（见下） |
| `remoteSession` | `close` | `close` 在 teardown 前发 ACP `session/close`；`keep` 跳过，让目标保留持久化会话历史（ACP 无删除 API，因此不会删除任何东西） |
| `timeoutMs` | `600000` | prompt 预算；超时则取消该次运行 |
| `sshArgs` | `[]` | 额外 ssh 选项 |
| `remoteCommand` | `dsh` | 远端可执行文件；app-bundle 安装需要绝对路径 + env wrapper |
| `remoteArgs` | `['--profile','acp']` | 远端参数 |
| `remoteShell` | 按 `cwd` 自动判定 | SSH 远端 shell 载体：`posix`（`sh -c`，带 pid 探测）或 `cmd`（Windows OpenSSH，命令直接交给 `cmd.exe`）。`cwd` 为盘符路径时自动选 `cmd`；一般无需手写 |
| `profile` / `local` / `localCommand` / `localArgs` | — | 不起 SSH，改为在本机跑一个 `dsh --profile acp` |
| `spawnCwd` | — | ssh/dsh 子进程的本地 cwd（默认用 harness cwd） |
| `scrubEnv` | SSH 默认 `true`，local 默认 `false` | spawn 前从子进程环境里剔除凭证形变量（`*_API_KEY`、`*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_AUTH`、`*_COOKIE`、`*_SESSION`、`*_DSN`、`DATABASE_URL` …）；保留 `SSH_AUTH_SOCK` 以支持 agent forwarding。本地 DSH peer 通常需要父进程的 provider env，所以本地模式是显式 opt-in |
| `env` | `{}` | 显式变量，在 scrub **之后**叠加（有意的逃生口）。SSH 模式下只有远端 `sshd` 接受（`SendEnv`）才会转发；本地模式直接传入 |
| `disposeGraceMs` | local `5000` / SSH `10000` | 每级终止的 teardown 宽限期；上限 `60000` |
| `expectAgentName` | — | peer 的 `agentInfo.name` 不符时在 `initialize` 阶段失败（身份/版本闸门）；实际观测到的名字始终以 `agent=` 写进诊断 |

### Windows 远端

`cwd` 用 Windows 绝对路径即可，插件会自动选择 cmd 载体：

```yaml
- name: win
  ssh: win-host            # ~/.ssh/config 别名或 user@host
  cwd: C:/Users/me/work    # 必须是远端已存在的 Windows 目录
  permission: read-only
```

远端需要 `dsh` 在其 SSH 会话的 `PATH` 上（默认 `remoteCommand: dsh`，由 `cmd.exe` 解析）；
若 PATH 命中旧版，可把 `remoteCommand` 指到桌面版 `dsh.cmd` 的绝对路径。cmd 载体不依赖
Git Bash；远端 pid 探测不可用，teardown 仍会关闭 ACP 会话并结束 ssh 子进程。

### 中继到工作站无法直接认证的机器

如果主机 A 能 ssh 到主机 B，但工作站的密钥没有授权到 B，可以拿 A 当 SSH 端点，把嵌套 ssh
作为远端命令：

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

### 本地模式（不走 SSH）

`local: true` 在本机跑第二个 DSH `acp` profile，而不是走 SSH。适合无网络时演练同一条委派
链路，也适合 DSH 只以 app-bundle 二进制形式存在的机器：

```yaml
- name: local-dsh
  provider: remote-local
  local: true
  profile: acp
  cwd: C:/Users/me/workspace        # 绝对路径；父会话 cwd 是绝对路径时以父会话为准
  permission: read-only
# 可选：localCommand: C:/path/to/dsh.cmd   （显式启动器优先于自动探测）
```

已验证：本地子进程报告本机 hostname 与父会话工作区；`stopReason=completed`；ACP profile
打到 stdout 的模型列表行被当作 `stdoutNoise` 容忍。

### 插件页配置（Web/桌面）与 JSON overlay

在 Web 或 DSH 桌面 UI 里，**远端子智能体**以卡片形式出现在**插件（Plugins）**页；点开是完整
配置页。这是官方的按插件配置位（`plugins.item` slot，与官方 subagent/shell 设置页同一套界面）。
页面是一个小的 module-loader bundle + Host 侧 `/api/dsh-subagent-remote` RPC，不依赖官方
client 包；缺少可选 client 服务或插件页 slot 时会降级为普通 Settings 区块（不会拖垮启动路径）：

- 列出生效主机（名称、端点、工作区、权限、远端会话策略、env-scrub 状态、哪台是默认）；
- **设为默认**持久化默认主机（立即生效，包括未传 `host` 的工具调用）；
- **测试连接**执行真实的 `ssh -T -o BatchMode=yes -o ConnectTimeout=10 <host> -- echo ok`
  探测，单次 25 秒超时、自动重试一次（以 `stdin: 'ignore'` spawn；本地 peer 立即返回）。
  慢建立或瞬时抖动的 SSH 握手不再被误报为失败；
- **编辑**把字段覆盖写入插件自己的 JSON overlay，**恢复 YAML 值**再把它们删掉；
- **添加主机**把新主机追加到 overlay；页头显示实时的 `当前 N 台主机，默认 X` 状态行；
- **禁用**让主机下线但不删除基线定义（卡片仍可见并标 已禁用；**启用**可恢复）。
  overlay 添加的主机还提供**删除**；YAML 主机不能删除——只能禁用——因为 profile patch
  始终是唯一真源。

页面上的每次写入都**立即生效（热加载）**：插件 dispose 并重新注册受影响的
`ctx.subagents.registerProvider` effect（subagent seam 是 effect 作用域、HMR 安全——摘除
provider 只阻止新的 start，不会撤销已返回的运行）。卡片会闪一下「已生效：更新 …」徽标，
无需重启。直接手改 JSON 文件则在下次重启时生效；此时页面改为显示「检测到外部文件改动，重启
后生效」横幅。

overlay 路径是 `$DSH_HOME/subagent-remote.json`（原子 temp+rename 写入）。它是 profile
patch **之上的增量**，从不改写 patch 本身：

```jsonc
{
  "defaultHost": "mac",
  "hosts": {
    "host-a": { "permission": "ask", "cwd": "/srv/work" },
    "extra":   { "ssh": "user@host", "cwd": "/home/user", "remoteSession": "keep" }
  }
}
```

委派省略 `host` 时的解析顺序：会话选择（`/remote-host <name>`）→ overlay
`defaultHost` → profile `defaultHost` → 唯一配置的主机。页面里改的默认选择和主机**定义**
都是实时的：下一次委派就用新值（无需重启）。Headless 和 ACP 部署没有
`connection`/`commands` 服务：插件照常加载、委派照常可用，只是没有 UI 界面。

同一个切换器也可以会话内使用：

```text
/remote-host            # 列出主机，并标记当前使用的主机
/remote-host mac        # 本次会话使用 mac
/remote-host reset      # 清除会话选择
```

### 会话顶部指示器

Web/Desktop 部署下，派发远端任务后会话头部会出现一个 `⇄ <host>` 指示器，位置在官方
「子智能体」与「后台任务」之后（`conversation.session.header.actions`，slot order 30）：

- **运行中**：显示主机、状态、已运行秒数；展开可看 endpoint、权限、工具次数和最近工具。
- **完成 / 失败 / 取消**：保留约 10 分钟，显示耗时、工具次数、结果摘要（截断）与错误类别。
- 数据来自 Host 侧内存注册表（`lib/runs.js`，上限 64 条），不写会话事件；DSH 重启后清空。
- Headless / ACP 部署没有 `connection` 插槽，指示器不出现，但委派、诊断与结果不受影响。

### 自动委托提示

插件向 `ctx.systemPrompt` 注册一个 `tool:remote-subagent` 段（order 与官方 `TOOL_SUBAGENT`
相同，2800），内容随主机列表动态变化：主机名、平台（Windows/POSIX）、`cwd`、`description`、
权限，以及“何时用 / 何时不用”的说明。没有启用主机时该段为空。

因此新会话不需要用户点名插件或工具名：当任务需要另一台机器（例如 Windows-only 命令、
某台机器的工作区/文件/凭据）时，模型会自行选择 `remote_subagent`。统一的 tool description
也会带上主机能力摘要与使用时机。提示词还明确告知：派发后不要轮询（`list_agents`/`job_list`）
或 sleep，直接结束本轮等运行时完成通知。

**开关**：插件页顶部「自动注入委托提示」默认开启，状态写入 overlay 的 `autoPrompt`。
关闭后不再向系统提示词注入任何内容，但 `remote_subagent` 工具、主机配置和 `/remote-host`
仍然可用——适合你希望完全手工提醒模型的场景。

### 异常与未结算任务（P0）

一次性的远端任务在本机 Host 重启/崩溃时，远端可能已经完成、也可能被中断，插件无法得知。
`lib/journal.js` 会把运行快照持久化到 `$DSH_HOME/storages/dsh-subagent-remote/runs.json`：
启动/结束同步落盘，运行中的进度做 1 秒防抖。

- 重启后，上次仍为 `running` 的记录标为 **orphaned**（`中断待核对`），保留 7 天，而不是失败或静默消失；
- 插件页顶部显示「上次有 N 个未结算的远端任务」，带主机、开始时间、remote session id 和「清除记录」；
- 顶部指示器对 orphaned 显示 `interrupted — verify`，展开可看详情；
- 仅解决“看得见/可对账”，**不自动重试、不重连、不续跑**；远端副作用仍需人工核对。

## 权限模型

需要审批的远端工具调用之前，ACP 会先问客户端（`session/request_permission`）。DSH 的 ACP
服务端只发 tool-call id，所以本插件把 prompt 与前一条 `tool_call` update 关联起来，按
工具名/参数分类（DSH 的 ACP `kind` 恒为 `other`）。

| 模式 | 远端只读工具 | 远端写/执行工具 |
|---|---|---|
| `read-only`（默认） | 允许 | 拒绝；诊断记录原因 |
| `ask` | 允许 | 派发时在 **turn 内**申请一次整轮运行授权；获批 → 允许，否则拒绝 |
| `deny` | 拒绝 | 拒绝 |
| `auto` | 允许 | 允许（显式 opt-in，风险已记录） |

`ask` 为什么在派发时授权：DSH 的审批 seam（`ctx.approval.request`）是 turn 封闭的，而远端
子智能体运行会超出发起它的 turn。turn 结束后才到的权限请求无法到达真人，因此逐工具
prompt 必然 fail closed。插件改为趁 turn 还开着，一次性申请整轮授权；没人能回答时
（headless、审批被禁用），运行以**未授权**开始，此后每个有风险的远端工具调用都被拒绝。
没有回答时，fail-closed 是唯一结局。

**`read-only` 只是启发式，不是安全边界。** 分类基于 peer 自报的 tool `title` 加一份保守的
shell 写模式扫描；恶意或被攻陷的 peer 可以谎报工具，扫描也覆盖不全（重定向、`python -c`、
`curl -X POST`、嵌套 `ssh` …）。白名单里还包含网络工具（`web_fetch`）和 `env`。对不信任
的目标请用 `deny` 或远端沙箱；把远端 closing message 当作父模型输入的**不可信内容**
（它没有被 provenance 包装）。

## 失败行为

* 任务在 spawn 任何进程**之前**校验：只接受 text block，且至少一个非空 block。其他情况
  一律以 `invalid-request` 结束，而不是让远端去回答一个不同的问题。
* spawn/SSH/initialize/session 失败会把子智能体结算为 `error`，带固定失败事实和内置提示；
  父会话继续运行。
* 协议完整性 fail-closed：未知的服务端请求、或 `session/update` 指向了别的会话，会让整次
  运行失败（先应答/取消 peer，再 teardown），而不是被忽略。
* 远端 turn 以 `cancelled` 结束（是 peer 停的，不是本客户端）时报告为 `aborted`，部分回答
  绝不会被误认为完成。
* 超时或父会话取消时发送 `session/cancel`，等一段有界宽限期（`disposeGraceMs`），再关闭
  会话并杀掉传输进程（Windows 用 `taskkill /T`，其他平台 `SIGTERM`/`SIGKILL`），若 SSH
  握手抓到了远端 pid 还会回收它。
* peer stdout 上的非 JSON 行会被容忍并计数；原始行只在 debug 下可见（见下）。
* 远端工作区路径：管理器始终注入父会话的绝对 cwd。SSH 主机只在该路径是 POSIX 路径时才用它，
  否则回退到主机的 `cwd`；当主机 `cwd` 是盘符路径（Windows 远端）时一律使用主机 `cwd`
  （否则 POSIX 父会话的路径会让远端 `session/new` 失败）。
* 失败时诊断还会携带 `peerExit`（code/signal/pid），因此传输死掉和远端任务失败可区分。

## 诊断

失败时先给**固定事实**：`failure: stage=… category=…`
（stage：`dispatch`/`spawn`/`initialize`/`session-new`/`prompt`；category：
`invalid-request`/`protocol`/`transport`/`auth`/`host-key`/`dns`/`remote-workspace`/
`credential`/`product-error`/`invalid-result`/`process`/`teardown`/`unknown`），
外加内置提示、权限决定、`agent=name/version`、`envScrubbed`、`peerExit`。原始错误文本、
stderr 尾巴和 stdout noise 都是 **debug-only**：

```bash
# POSIX：给正常的 dsh 命令加前缀
DSH_SUBAGENT_REMOTE_DEBUG=1 <your dsh command>   # 再派发一次，原始 payload 就会出现
```
```powershell
# PowerShell
$env:DSH_SUBAGENT_REMOTE_DEBUG = '1'
```

远端是另一个信任域。默认诊断只带固定事实、内置提示和计数器；确实出现的远端来源值
（`agent=` 名字/版本、`remoteTools` 里的工具 title）会去掉控制字符，但仍应按不可信文本对待，
和 closing message 本身一样。原始 stderr/stdout（可能含远端路径或主机名）只在 debug 下出现：
`DSH_SUBAGENT_REMOTE_DEBUG=1` 会把远端文本放进父会话，所以不要对不可信目标开启，也不要
公开粘贴。stderr 是防御式解码的：远端命令的 stderr 是 UTF-8，而 Windows OpenSSH 自己的
本地化消息是 GBK——并且当它的 stderr 是管道时，会把非 ASCII 文本写成 C 八进制转义
（`\262\273\326\252…`）。插件两种都解码，所以一条 `zh-CN` 的 Windows 错误会显示成
「不知道这样的主机。」而不是八进制噪声（debug 模式下可见）。

## 安全与边界

- **远端机器是被信任的**：插件会在目标机器上运行 DSH 及其工具。只配置你控制的主机。
- **不内置任何主机、账号或密钥**：主机定义来自 profile patch 或插件的 JSON overlay；
  SSH 凭据完全走本机 `ssh` 配置（agent/密钥）。
- **凭证 env scrub** 对 SSH peer 默认开启（`scrubEnv: true`），并保留 `SSH_AUTH_SOCK`
  以支持 agent forwarding；显式 `env` 在 scrub 之后叠加（只有远端 `sshd` 接受
  `SendEnv` 时才会转发）。
- **主机密钥**继承本机 ssh 配置；`BatchMode=yes` 让未知 host key 直接 fail closed。
  `StrictHostKeyChecking=accept-new` 等于接受首次连接的 TOFU 风险，建议之后核对指纹。
- **`read-only` 不是安全边界**（见上面的权限模型）；对不可信目标请用 `deny` 或远端沙箱。
- **远端输出不可信**：closing message 以及诊断中远端来源的值可能对父会话构成 prompt
  injection；请按外部输入对待。
- **远端会话历史不会被删除**：`remoteSession: close` 只关闭 ACP 会话（ACP 没有删除 API）。
- **调试开关**：`DSH_SUBAGENT_REMOTE_DEBUG=1` 会把远端原始 stderr/stdout（可能含远端路径/
  主机名）暴露到父会话；只在你控制的机器上临时开启，不要公开粘贴输出。
- **无遥测**。完整信任模型与漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 开发与验证

欢迎贡献：提交前保持 `npm run check && npm test` 全绿；安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。

### 测试

```bash
# 纯单元测试（不需要 DSH、网络、凭据）——CI 也跑这些
node test/policy-selftest.mjs     # 权限策略
node test/tool-selftest.mjs       # 统一工具定义 + 派发 + 默认主机解析
node test/config-selftest.mjs     # 配置、委托提示段、ssh 校验、任务校验、失败、诊断、stderr 解码、env scrub
node test/settings-selftest.mjs   # overlay 合并/原子状态、主机选择、RPC 信封、热加载 payload
node test/runs-selftest.mjs       # 运行注册表、restore/snapshot、orphan 保留（成功时不打印逐条）
node test/journal-selftest.mjs    # 持久化日志 roundtrip、orphan 恢复、损坏文件、原子写入
node test/transport-selftest.mjs  # 对着 mock peer 的 ACP 传输
node test/client-contract-selftest.mjs  # client bundle 的 `inject` 契约（每个 ctx.<service> 都已声明）
npm run check                     # 对每个源码文件 node --check
npm test                          # 全部八个套件（395 条打印检查 + runs-selftest，约 4 秒）
```

最新证据：2026-11-09 在 macOS（Node 26.13.0）上以 `0.9.2-rc.8` 跑通 `npm run check`
与 `npm test`——八个套件全过，含 `PASS client-contract-selftest`；`engines.dsh` 兼容
窗口已在本机 DSH 0.2.1-rc.5 与 0.2.2-rc.1 安装上核对。`runs-selftest.mjs` 只在失败时
打印，因此全绿时会以 `PASS runs-selftest` 行结尾。

端到端与 Playwright 验收 harness 只存在于维护者 checkout，不在发布包里。npm tarball
完全不含 `test/`（八个离线套件保留在仓库/CI），这个切分由 `files` 控制。

transport 套件会 spawn `test/fixtures/mock-acp-peer.mjs`（行为由
`MOCK_MODE=ok|permission|hang|noise|crash|unknown-request|session-mismatch|env` 选择），
断言：正常完成、权限 allow/deny/fail-closed、超时、AbortController 取消、stdout noise
容忍、peer 崩溃、未知请求 fail-closed、外来会话拒绝、凭证 env scrub、remote-session
close vs keep、期望 agent 不匹配——外加一个孤儿审计，确认每个 mock peer 都已退出。

### 升级检查清单

这里的协议事实是以 DSH **0.2.1-rc.2** 实测的，到 0.2.2-rc.1 的验证 pass 为止未变。
任一端升级 DSH 后：

1. `npm test`（全部八个套件）——捕获配置/协议契约漂移。
2. 对每台配置的主机跑一次只读委派（维护者的端到端 harness 在本地 checkout，不在本包里）。
3. 看完成通知的 `agent=` 行：ACP 服务端的 `agentInfo.version` **不是** DSH 版本，真正
   的版本闸门需要带外检查（`ssh <host> dsh --version`）；`expectAgentName` 只钉 agent 身份。
4. 新增协议交互之前：未知帧的语义是失败，不是跳过。Host-key 校验跟随本机 ssh 配置；
   `BatchMode` 让未知 key fail closed。若你加 `accept-new`，就等于接受 TOFU。

### 后端规范

本 provider 遵循官方 out-of-process 后端规范：provider capabilities 全为 false、`result`
永不 reject、publish-before-return + 异步结算、固定失败分类、凭证 env scrub、未知协议帧
fail-closed、原始 payload 仅 debug 可见。刻意的差异是：我们的 `start()` 立即返回并异步
结算，因为远端 ACP 运行无法在 publishing 调用内完成握手。

### 发布

1. 改 `package.json` 的 `version` 并在 `CHANGELOG.md` 加条目。
2. `npm run check && npm test`。
3. 提交版本号后，用同一版本打标签并推送（或在 UI 里手动跑 **publish** workflow）：
   `git tag v0.9.2-rc.8 && git push origin main --tags`。标签 `vX.Y.Z` 与
   `package.json` 不一致时 workflow 会拒绝。
4. `.github/workflows/publish.yml` 带 npm provenance（OIDC）发布；预发布版本进 `next`
   dist-tag，正式版进 `latest`。需要仓库 secret `NPM_TOKEN`；`prepublishOnly` 会在本地
   重跑检查。

### CI

`.github/workflows/ci.yml` 在每次 push/PR 上跑：Ubuntu、Windows、macOS × Node 22/24
（`npm run check` + 全部八个离线套件），另有独立打包 job 执行 `npm pack --dry-run` 并
断言 tarball 不含 `test/`、`.git*`、`.tgz`。Playwright 设置页验收刻意不进 CI（它需要
运行中的 Web UI）。

## 安装 / 卸载 / 回滚

### 安装

使用上面任一[安装形态](#安装形态)：官方插件页输入 npm 包名，或
`dsh plugin --profile <profile> add dsh-subagent-remote`。装完重启 DSH（Host 半在 profile
启动时加载）；只改 client 资源的话刷新页面即可。

### 卸载

```bash
dsh plugin --profile <profile> remove dsh-subagent-remote
```

或在插件页移除，然后重启 DSH。可选清理：删除 overlay `$DSH_HOME/subagent-remote.json`
——它保存页面添加的主机和默认主机选择（打算重装就保留）——以及运行日志目录
`$DSH_HOME/storages/dsh-subagent-remote/`（有界运行快照，含 orphaned 记录）。远端持久化
会话不会被删除（见已知限制）。

### 回滚

- **registry 安装**：钉回上一个已发布构建再重启：
  `dsh plugin --profile <profile> add dsh-subagent-remote@next`（rc.8）或 `@0.9.2-rc.4`（latest）。
- **link/开发安装**：在 checkout 里 `git checkout <previous-commit-or-tag>`，然后重启 DSH。
- **只回滚配置**：恢复/删除 JSON overlay（或 profile patch 备份）；手改的 overlay 需要重启，
  页面里的编辑是热生效的。

## 已知限制（V1/V2）

* 只支持一次性任务：没有后续消息、没有 cold resume、没有 `list_agents` 可见性（外部激活
  没有本地会话）。这与官方 ACP 子智能体后端是同一份契约。
* profile patch（YAML）里的主机只能禁用、不能从页面删除；overlay 添加的主机可以删除。
  主机的**定义**仍在 profile patch：页面编辑的是 JSON overlay（增量，不是第二真源）。页面
  编辑热生效；只有手改的 JSON 文件需要重启，页面会报告该状态。
* 远端任务会在目标机器上留下持久化 DSH 会话；插件在诊断里报告其 id 并关闭它，但不删除历史。
* read-only 分类是保守启发式（工具名白名单 + shell 写模式扫描），不是完整静态分析。
* 运行日志是本地快照：它让被中断的运行「看得见」，但无法判断远端是否已完成；核对仍需人工，
  且没有自动重试/续跑。

## 兼容性

| 组件 | 支持 / 已验证 |
|---|---|
| Host DSH | `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`；已在 `0.2.1-rc.5` 与 `0.2.2-rc.1` 验证 |
| Host Node | `engines.node: ">=22"`（CI 矩阵 Node 22/24） |
| 本地父会话 UI | Web / DSH 桌面：插件页、会话顶部指示器、`/remote-host`；headless/ACP profile 无 UI 也能工作 |
| 远端 OS | POSIX（`sh -c`，带 pid 探测）或 Windows OpenSSH（`cmd.exe` 载体，盘符 `cwd`） |
| npm 已发布构建 | `0.9.2-rc.3`、`0.9.2-rc.4`（`latest`）、`0.9.2-rc.8`（`next`）；`0.9.2-rc.5`–`0.9.2-rc.7` 从未发布 |

- 唯一的兼容闸门是 `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`（与 `engines.node: ">=22"` 并列）；
  DSH 的插件工具链以 `engines.dsh` 作为 DSH 版本窗口的权威依据。旧的
  `dsh.compatibility` / `dsh.compatibility.dshReleases` / `dsh.plugin` 清单字段已在
  `0.9.2-rc.5` 删除——DSH 0.2.1-rc.5 从不消费它们，它们从来不是真正的闸门。
- Client 半是自包含的纯 HTML/CSS。DSH 0.2.1-rc.5 的 client 插件规范禁止插件把
  Harness Client 包（`@deepseek-ai/dsh-client-*`）当模块 import；原先带 guard 的
  `dsh-client-ui-primitives` require（及其 `dsh.client.inject` 条目）已在 `0.9.2-rc.5`
  删除。在 DSH 0.2.1-rc.5 上插件页渲染不变（那里 require 本来就会抛错、实际跑的就是这套纯
  HTML 控件）；在仍带 primitives 的旧版本上，页面改用插件自带的这套控件，功能等价、字体
  样式走插件自己的设计 token。
- 已在本机 **DSH 0.2.1-rc.5** 桌面安装上验证（2026-11-04；Windows 桌面父会话 → Linux、
  macOS 与本地 `acp` 目标），并在 **DSH 0.2.2-rc.1** 上验证 macOS 父会话 → Windows 远端
  （2026-11-05，cmd 载体；远端执行 Windows-only PowerShell 任务并回传 closing message）。
  同一版本上验证了 Web UI 的会话顶部指示器：位置在官方「N subagents」之后，running →
  done 状态与详情菜单均正常。`rc.7` 新增该指示器；`rc.8` 在委派协议不变的前提下加入持久化
  运行日志与 orphaned 可见性，八个离线套件已复跑（2026-11-09）。

| 插件 | DSH | npm | 状态 |
|---|---|---|---|
| 0.9.2-rc.8 | `0.2.2-rc.1` | 已发布（`next`） | P0：run journal + orphaned 可见性（可见/可清除；无自动恢复） |
| 0.9.2-rc.7 | `0.2.2-rc.1` | 未发布 | 已验证（macOS 父会话 → Windows 远端；Web UI 会话顶部指示器 running → done）— 自动委托提示 + 会话顶部运行指示器 |
| 0.9.2-rc.6 | `0.2.2-rc.1` | 未发布 | 已验证（macOS 父会话 → Windows 远端，cmd 载体；Windows 父会话 → Linux/macOS 目标）— Windows 远端支持 |
| 0.9.2-rc.5 | `0.2.1-rc.5` | 未发布 | 已验证（Windows 桌面父会话；Linux/macOS 目标）——打包/展示 pass |
| 0.9.2-rc.4 | `0.2.1-rc.3` | 已发布 | 已验证（Windows 桌面父会话；Linux/macOS 目标）— 桌面启动热修复 |
| 0.9.2-rc.4 | `0.2.1-rc.2` | 已发布 | 已验证 |
| 0.9.2-rc.3 | `0.2.1-rc.3` | 已发布 | marketplace 打磨、插件页 + 图标 |

## License

MIT —— 见 [LICENSE](LICENSE)。Copyright © 2026 Xingchen Zhao。
