# 开源分享：用飞书接管 Claude Code / Codex CLI 的所有交互，手机上就能批准、选方案、输指令

> 你是否也有这样的体验：Claude Code 跑了半天，终于弹出一个权限确认，但你已经去泡咖啡了？
>
> 或者 Codex 跑完了一整个任务，你回来才发现它其实十分钟前就结束了？

今天开源一个我日常在用的小工具 —— **Agent Notifier**，把 Claude Code 和 Codex CLI 的所有交互搬到飞书，手机上就能操作，再也不用守在终端前。

**GitHub 地址：[https://github.com/KaminDeng/agent_notifier](https://github.com/KaminDeng/agent_notifier)**

---

## 一、它解决什么问题

用 Claude Code 或 Codex CLI 写代码，最大的痛点不是 AI 不够聪明，而是 **交互断层**：

- AI 需要你批准执行一个命令 → 你不在电脑前 → 任务卡住
- AI 给了你三个方案让你选 → 你没看到 → 任务卡住
- 任务跑完了 → 你不知道 → 白白等了半小时

本质上，这些 CLI 工具**没有移动端的交互能力**。你必须守在终端前，实时盯着输出。

**Agent Notifier 的做法很简单：把飞书变成你的远程终端控制器。**

| 痛点 | 解法 |
|------|------|
| 等权限确认，必须守在终端前 | 飞书卡片实时推送，手机点一下就行 |
| 想在手机上操作，但没有官方 App | 飞书就是多端 App，iOS / Android / Mac / Windows / Web 全覆盖 |
| 自建推送要服务器、域名、备案 | 飞书长连接模式，不需要公网 IP，本机直连 |
| 企业审批流程繁琐 | 飞书企业自建应用秒审批，个人也能用，**完全免费** |
| 多终端同时跑任务，通知乱了 | 多终端并行路由，每个终端独立送达，互不干扰 |

---

## 二、效果展示

直接看飞书手机端的实际截图：

### 权限确认 & 方案选择

当 Claude Code 需要你批准执行命令，或者 AskUserQuestion 弹出选项时，飞书会收到交互式卡片：

<div align="center">
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/permission-confirm.jpg" width="260" />
&nbsp;&nbsp;
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/permission-options.jpg" width="260" />
&nbsp;&nbsp;
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/ask-user-question.jpg" width="260" />
</div>

<p align="center"><sub>左：权限确认 — 允许 / 拒绝 / 会话允许 / 全局允许 + 输入框<br/>中：权限选项 — ExitPlanMode 等工具选项按钮 + 输入框<br/>右：方案选择 — AskUserQuestion 动态选项 + Other + 自由输入<br/>脚注：项目名 · 终端标识(fifo:/tmp/claude-inject-ptsN) · 会话时长 · 时间戳</sub></p>

点按钮或输入文字，操作会**直接回流到本地终端**，就像你在键盘上打字一样。

### 实时执行摘要

Claude 每执行一步工具调用，飞书会实时推送执行摘要卡片，同一任务的卡片会原地更新，不会刷屏：

<div align="center">
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/live-execution.jpg" width="280" />
</div>

<p align="center"><sub>实时执行摘要 — 工具调用表格 · 同任务原地 patch 更新<br/>脚注：项目名 · 时间戳</sub></p>

### 任务完成通知

任务跑完后，会收到带改动总结、Token 用量、时长统计的完成卡片，底部还有输入框可以直接续聊：

<div align="center">
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/task-complete.jpg" width="280" />
&nbsp;&nbsp;&nbsp;
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/task-complete-stats.jpg" width="280" />
</div>

<p align="center"><sub>左：改动总结 + 输入框续聊<br/>右：测试结果表格 + 输入框续聊<br/>脚注：项目名 · 会话时长 · 时间戳 · Token 用量统计（输入/输出/缓存读写）</sub></p>

---

## 三、支持的卡片类型

| 场景 | 卡片颜色 | 说明 |
|------|---------|------|
| 权限确认 | 🟠 橙色 | 允许 / 本次会话允许 / 拒绝 + 输入框 |
| AskUserQuestion 单选 | 🟠 橙色 | 动态选项按钮 + Other + 输入框 |
| AskUserQuestion 多题 | 🟠 橙色 | Q1 → Q2 → Q3 逐张发送 |
| 任务完成 | 🟢 绿色 | 摘要、时长、Token + 输入框 |
| 异常退出 | 🔴 红色 | 错误详情 + 输入框 |
| 实时执行摘要 | 🔵 蓝色 | 同一任务原地 patch 更新 |

---

## 四、为什么选飞书而不是微信 / Telegram / Slack

这是我被问得最多的问题，解释一下：

1. **飞书自建应用是免费的**，个人账号就能创建，企业版也是秒审批
2. **飞书支持长连接（WebSocket）**，不需要你有公网 IP 或者域名，这意味着你在家、在公司、用 VPN，都能直接用
3. **飞书的交互式卡片能力非常强**，支持按钮、输入框、表格、多列布局，远超普通的消息推送
4. **飞书天然多端同步**，手机 / 电脑 / 平板 / 网页版都能收到同一张卡片并操作
5. **不需要开发独立 App**，飞书客户端本身就是你的"遥控器"

当然，架构上做了通道抽象（`src/channels/`），如果你想接其他平台，扩展起来也不难。

---

## 五、5 分钟上手

### 前置条件

- Node.js >= 18
- Python 3（用于 PTY 终端代理）
- 一个飞书账号

### 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/KaminDeng/agent_notifier.git
cd agent_notifier

# 2. 编辑 .env 填入飞书应用凭证（首次运行会自动创建）
#    FEISHU_APP_ID=your_app_id
#    FEISHU_APP_SECRET=your_app_secret

# 3. 一键安装（自动完成所有配置）
bash install.sh

# 4. 重新加载 shell
source ~/.zshrc  # 或 source ~/.bashrc

# 5. 像往常一样使用
claude
```

`install.sh` 会自动完成：
- 安装 npm 依赖
- 写入 Claude Code hooks 到 `~/.claude/settings.json`
- 注入 `claude` / `codex` shell 包装函数
- **启动飞书监听器并注册开机自启**（macOS 用 launchd，Linux 用 systemd）

> 重复运行 `install.sh` 是安全的 — 每次会先自动清理再重新安装。

### 飞书应用配置（3 分钟）

1. 登录 [飞书开放平台](https://open.feishu.cn)，创建企业自建应用
2. 复制 App ID / App Secret，填入 `.env`
3. 开启机器人能力
4. 事件订阅选择 **长连接**（不需要公网 IP）
5. 添加事件：`card.action.trigger`
6. 申请权限：`im:message`、`im:message:send_as_bot`、`im:chat:readonly`
7. 发布应用，把机器人加入目标群

就这些，没有域名、没有备案、没有服务器。

---

## 六、跨平台支持

| 平台 | 服务管理 | 开机自启 |
|------|---------|---------|
| macOS | launchd | RunAtLoad + KeepAlive |
| Linux (systemd) | systemd user service | systemctl --user enable |
| Linux (SSH/无 systemd) | nohup + crontab @reboot | crontab 回退 |

卸载也是一行命令：

```bash
bash uninstall.sh
```

会自动清理所有配置、停止服务、移除 hooks 和 shell 注入。

---

## 七、工作原理（简要）

整体分两条链路：

**Claude Code 链路：**
```
Claude Hooks 触发事件 → hook-handler.js 解析 → 生成飞书交互卡片
                                                       ↓
用户在飞书点击/输入 → feishu-listener.js 接收回调 → 注入回本地终端
```

**Codex CLI 链路：**
```
pty-relay.py 建立 PTY 终端代理 → 捕获 Codex 输出 → 生成飞书卡片
                                                       ↓
用户在飞书点击/输入 → feishu-listener.js 接收回调 → 通过 FIFO 注入终端
```

终端注入支持多种方式：tmux、PTY FIFO、pty master 直写、TIOCSTI，自动检测最优方案。

---

## 八、项目结构

```
agent_notifier/
├── install.sh / uninstall.sh          # 安装 / 卸载
├── hook-handler.js / live-handler.js  # Claude Hooks 入口（薄 shim）
├── bin/
│   └── pty-relay.py                   # PTY 终端代理
├── src/
│   ├── apps/                          # 应用入口（claude-hook、claude-live、feishu-listener 等）
│   ├── adapters/                      # Claude / Codex 适配器
│   ├── channels/                      # 飞书通道（卡片渲染、客户端、交互处理）
│   ├── core/                          # 底层原语（session store、terminal injector）
│   └── lib/                           # 应用级服务（env config、session state、terminal inject）
├── tests/                             # 81 个测试用例
└── scripts/                           # 调试 / 测试脚本
```

---

## 九、适合谁用

如果你符合以下任意一条：

- 日常用 Claude Code 或 Codex CLI 写代码
- 经常需要离开电脑，但不想任务卡在权限确认上
- 想在手机上也能操作 AI 编程助手
- 同时开多个终端跑不同任务，需要统一的通知入口

那这个工具就是为你设计的。

---

## 十、最后

项目完全开源，MIT 协议，欢迎 Star、Fork、提 Issue。

**GitHub 地址：[https://github.com/KaminDeng/agent_notifier](https://github.com/KaminDeng/agent_notifier)**

如果你觉得这个工具有用，帮忙点个 Star 就是最大的支持。有问题也欢迎在 Issues 里交流。
