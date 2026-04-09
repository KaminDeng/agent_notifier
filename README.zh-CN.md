[English](./README.md) | [中文](./README.zh-CN.md)

# Agent Notifier — Claude / Codex CLI 飞书通知助手

> 把 AI 编程助手的所有交互搬到飞书，手机上就能批准、选方案、输指令，多终端同步，不用盯着终端。

## 为什么选择这个方案

| 痛点 | 本项目的解法 |
|------|-----------|
| Claude / Codex 等权限、要确认，你必须守在终端前 | 飞书卡片实时推送，手机 / 电脑 / 平板任意设备点一下就行 |
| 想在手机上也能操作，但没有官方 App | 飞书就是你的多端 App，iOS / Android / Mac / Windows / Web 全覆盖 |
| 自建推送要服务器、域名、备案？ | 飞书长连接模式，不需要公网 IP 和域名，本机直连 |
| 企业审批流程繁琐？ | 飞书企业自建应用秒审批，个人也能用，完全免费 |
| 多个终端同时跑任务，通知乱了？ | 多终端并行路由，每个终端的交互独立送达，互不干扰 |

---

## 效果预览

<table>
<tr>
<td align="center" width="33%">
<img src="./docs/images/permission-confirm.jpg" width="240" /><br/>
<b>权限确认</b><br/>
<sub>允许 / 拒绝 / 会话允许 / 全局允许 + 输入框<br/>脚注：项目名 · 终端标识(fifo) · 会话时长</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/permission-options.jpg" width="240" /><br/>
<b>权限选项</b><br/>
<sub>ExitPlanMode 等工具选项按钮 + 输入框<br/>脚注：项目名 · 终端标识(fifo) · 会话时长</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/ask-user-question.jpg" width="240" /><br/>
<b>方案选择</b><br/>
<sub>AskUserQuestion 动态选项 + Other + 自由输入<br/>脚注：项目名 · 终端标识(fifo) · 时间戳</sub>
</td>
</tr>
<tr>
<td align="center" width="33%">
<img src="./docs/images/live-execution.jpg" width="240" /><br/>
<b>实时执行摘要</b><br/>
<sub>工具调用表格 · 同任务原地 patch 更新<br/>脚注：项目名 · 时间戳</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/task-complete.jpg" width="240" /><br/>
<b>任务完成</b><br/>
<sub>改动总结 + 输入框续聊<br/>脚注：项目名 · 会话时长 · Token 用量统计</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/task-complete-stats.jpg" width="240" /><br/>
<b>完成通知（带统计）</b><br/>
<sub>测试结果表格 + 输入框续聊<br/>脚注：项目名 · 会话时长 · Token 用量统计</sub>
</td>
</tr>
</table>

---

## 支持的卡片类型

| 场景 | 卡片颜色 | 说明 |
|------|---------|------|
| 权限确认 | 🟠 橙色 | 允许 / 本次会话允许 / 拒绝 + 输入框 |
| AskUserQuestion 单选 | 🟠 橙色 | 动态选项按钮 + Other + 输入框 |
| AskUserQuestion 多题 | 🟠 橙色 | Q1 → Q2 → Q3 逐张发送 |
| 任务完成 | 🟢 绿色 | 摘要、时长、Token + 输入框 |
| 异常退出 | 🔴 红色 | 错误详情 + 输入框 |
| 实时执行摘要 | 🔵 蓝色 | 同一任务原地 patch 更新 |

---

## 功能一览

**通知能力** — 飞书交互式卡片 / 任务完成与失败通知 / 实时执行摘要 / 会话时长与 Token 统计 / 本地语音提醒

**交互能力** — 按钮点击回流终端 / 文本输入回流终端 / 多终端并行路由 / Claude 与 Codex 共用一套入口

---

## 快速开始

### 1. 克隆仓库

```bash
git clone <repo-url>
cd agent_notifier
```

### 2. 配置飞书应用

编辑 `.env`（首次安装会自动从 `.env.example` 创建）：

```bash
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here
# FEISHU_CHAT_ID=
```

> 飞书自建应用创建和审批流程见下方[飞书配置步骤](#飞书配置步骤)。

### 3. 一键安装

```bash
bash install.sh
```

安装脚本会自动完成：
- 检查依赖（Node.js、npm、python3）
- **清理旧配置**（自动调用 `uninstall.sh`）
- 安装 Node.js 依赖
- 从 `.env.example` 创建 `.env`（如不存在）
- 写入 Claude Code hooks 到 `~/.claude/settings.json`
- 注入 `claude` / `codex` shell 包装函数
- **自动启动飞书监听器并注册开机自启**

> 重复运行 `install.sh` 是安全的 — 每次会先清理再重新安装。

### 4. 重新加载 shell

```bash
source ~/.zshrc
# 或 source ~/.bashrc
```

### 5. 开始使用

```bash
claude
# 或
codex
```

---

## 卸载

```bash
bash uninstall.sh
```

卸载脚本会清理：
- 停止并移除飞书监听器服务（launchd / systemd / crontab）
- 终止后台进程（feishu-listener、codex-watcher、codex-session-watcher、pty-relay）
- 从 `~/.claude/settings.json` 移除 hooks
- 从 `~/.zshrc` / `~/.bashrc` 移除 shell 函数注入
- 清理运行时文件（session-state、pid、log、/tmp 缓冲文件）

> `.env` 和 `node_modules/` 会保留，如需完全清除请手动删除。

---

## 跨平台支持

| 平台 | 服务管理方式 | 开机自启 |
|------|------------|---------|
| macOS | launchd (`~/Library/LaunchAgents/`) | `RunAtLoad` + `KeepAlive` |
| Linux (有 systemd user session) | systemd user service | `systemctl --user enable` |
| Linux (无 systemd，如纯 SSH) | nohup + crontab `@reboot` | crontab 回退方案 |

### 服务管理命令

**macOS:**
```bash
# 查看状态
launchctl print gui/$(id -u)/com.agent-notifier.feishu-listener
# 停止
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.agent-notifier.feishu-listener.plist
# 启动
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-notifier.feishu-listener.plist
```

**Linux (systemd):**
```bash
systemctl --user status agent-notifier-feishu
systemctl --user restart agent-notifier-feishu
journalctl --user -u agent-notifier-feishu -f
```

---

## 配置说明

### `.env` 示例

```bash
# 飞书自建应用
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here
# FEISHU_CHAT_ID=

# 默认宿主（可选）
# DEFAULT_AGENT_HOST=claude
# CODEX_BIN=codex

# 显式指定 tmux pane（可选）
# CLAUDE_TMUX_TARGET=claude:0.0

# 实时摘要（可选）
# FEISHU_LIVE_CAPTURE=1
# FEISHU_LIVE_DEBOUNCE_MS=3000

NOTIFICATION_ENABLED=true
# NOTIFICATION_EXPIRE_HOURS=12
# ENABLE_ESC_BUTTON=true
SOUND_ENABLED=true
```

### `FEISHU_LIVE_CAPTURE` 的含义

可选值：
- `1` / `true`：全部开启
- `tools`：工具 / 命令摘要
- `output`：助手输出内容
- `results`：工具执行结果摘要
- 也可以组合：`tools,output,results`

Codex 的输出来自 `~/.codex/sessions/*.jsonl`，不是靠终端文本猜测。

---

## 飞书配置步骤

### 1. 创建自建应用
登录 [飞书开放平台](https://open.feishu.cn)，创建企业自建应用。

### 2. 获取 App ID / App Secret
在应用后台复制凭证，填入 `.env`。

### 3. 开启机器人能力
在应用能力里启用机器人。

### 4. 事件订阅选择长连接
不需要公网 IP 或域名。

### 5. 添加事件
- `card.action.trigger`

### 6. 申请权限
- `im:message`
- `im:message:send_as_bot`
- `im:chat:readonly`

### 7. 发布应用版本
发布后把机器人加入目标群。

---

## 常用命令

### 安装 / 卸载

```bash
bash install.sh      # 安装（自动清理旧配置 → 重新安装）
bash uninstall.sh    # 卸载（停止服务 → 清理配置）
```

### 飞书监听器（手动管理）

```bash
npm run feishu-listener         # 前台运行
npm run feishu-listener:start   # nohup 后台启动
npm run feishu-listener:stop    # 停止后台进程
```

### Codex 相关

```bash
npm run codex-watcher
npm run codex-watcher:start
npm run codex-watcher:stop
```

---

## 架构概览

### Claude 链路
- Claude Hooks 触发事件 → `src/apps/claude-hook.js` 生成卡片 → 飞书监听器接收回调 → 注入回本地终端

### Codex 链路
- `pty-relay.py` 建立终端桥接 → `src/apps/codex-watcher.js` 负责交互卡 → `src/apps/codex-session-watcher.js` 读取 session 文件 → `src/apps/codex-live.js` 负责实时摘要卡

### 终端注入方式

飞书输入想要真正送回 Claude / Codex，本项目支持多种方式：

| 方式 | 场景 |
|------|------|
| tmux | 推荐，在 tmux 会话中运行 `claude` / `codex` |
| PTY 代理 | 非 tmux 环境，`pty-relay.py` 自动建立 FIFO 注入通道 |
| 显式指定 tmux pane | `CLAUDE_TMUX_TARGET=claude:0.0` |

注入优先级：`CLAUDE_TMUX_TARGET` > 自动检测 tmux pane > FIFO 中继 > pty master 直写 > TIOCSTI 备用

### Hook 配置

使用 `install.sh` 会自动完成，手动配置写入 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js" }] }],
    "Notification": [{ "matcher": "permission_prompt|idle_prompt|elicitation_dialog", "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js" }] }],
    "PostToolUse": [{ "matcher": "Bash|Write|Edit|NotebookEdit", "hooks": [{ "type": "command", "command": "node /path/to/live-handler.js" }] }]
  }
}
```

---

## 验证与联调

```bash
# 跑测试
bun test tests/
python3 -m py_compile pty-relay.py

# 发测试卡
node scripts/send-codex-feishu-test-cards.js --pts /dev/pts/<N>
npm run ask:e2e:card
```

建议至少手动验证：
- Claude 完成卡发送是否正常
- Codex 文本输入 / 审批 / 单选 / 多选是否都能回流
- Codex live 卡是否同任务 patch、新任务 create
- 长文本是否被正确分块

---

## 注意事项

- PTY raw mode 下 Enter 是 `\r`，不是 `\n`
- 完成类卡片会带输入框，方便直接续聊
- `im.message.patch` 会丢失输入框，所以完成卡通常新建，执行中卡使用 patch
- 敏感配置放在 `.env`，不要提交

---

## 开发说明

如果你是来二次开发的，优先看：
- `docs/ai_rules.md`
- `docs/ai_docs/README.md`
- `src/apps/claude-hook.js`
- `src/apps/codex-live.js`
- `src/apps/codex-watcher.js`
- `src/channels/feishu/feishu-interaction-handler.js`

---

## License

[MIT](./LICENSE)
