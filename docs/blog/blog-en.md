# Open Source: Control Claude Code / Codex CLI Entirely from Your Phone with Feishu (Lark) — Approve, Choose, and Send Commands on the Go

> Ever had this happen? Claude Code has been running for a while and finally pops up a permission prompt — but you've already walked away to grab coffee.
>
> Or Codex finishes an entire task, and you only realize it when you come back — ten minutes too late.

Today I'm open-sourcing a little tool I use daily — **Agent Notifier**. It routes all interactions from Claude Code and Codex CLI to Feishu, so you can handle everything from your phone without being chained to the terminal.

**GitHub: [https://github.com/KaminDeng/agent_notifier](https://github.com/KaminDeng/agent_notifier)**

---

## 1. The Problem It Solves

When you use Claude Code or Codex CLI for coding, the biggest pain point isn't that the AI isn't smart enough — it's the **interaction gap**:

- The AI needs your approval to run a command → you're away from your desk → task stalls
- The AI offers three approaches and asks you to pick one → you don't see it → task stalls
- The task finishes → you have no idea → you've been waiting for nothing for 30 minutes

At its core, these CLI tools **have no mobile interaction layer**. You have to sit in front of the terminal, watching the output in real time.

**Agent Notifier's approach is simple: turn Feishu into your remote terminal controller.**

| Pain Point | Solution |
|------------|----------|
| Stuck waiting for permission prompts at the terminal | Feishu pushes interactive cards in real time — one tap on your phone |
| Want mobile access, but there's no official app | Feishu is a full multi-platform app — iOS / Android / Mac / Windows / Web |
| Self-hosted push notifications need a server, domain, and SSL | Feishu's long-connection (WebSocket) mode requires no public IP — direct local connection |
| Enterprise app approval is a bureaucratic nightmare | Feishu's custom enterprise apps get instant approval; personal accounts work too — **completely free** |
| Running tasks across multiple terminals, notifications get tangled | Multi-terminal parallel routing — each terminal gets its own delivery channel, no cross-talk |

---

## 2. What It Looks Like

Here are actual screenshots from the Feishu mobile app:

### Permission Confirmation & Option Selection

When Claude Code needs you to approve a command, or an AskUserQuestion prompt pops up with choices, Feishu sends you an interactive card:

<div align="center">
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/permission-confirm.jpg" width="260" />
&nbsp;&nbsp;
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/permission-options.jpg" width="260" />
&nbsp;&nbsp;
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/ask-user-question.jpg" width="260" />
</div>

<p align="center"><sub>Left: Permission confirmation — Allow / Deny / Allow for Session / Allow Always + text input<br/>Center: Permission options — Tool option buttons (e.g. ExitPlanMode) + text input<br/>Right: Option selection — AskUserQuestion with dynamic choices + Other + free-form input<br/>Footer: project name · terminal ID (fifo:/tmp/claude-inject-ptsN) · session duration · timestamp</sub></p>

Tap a button or type a response, and the action **flows directly back to your local terminal** — as if you were typing on your keyboard.

### Live Execution Summary

Every time Claude invokes a tool, Feishu pushes a real-time execution summary card. Cards for the same task update in-place instead of flooding your chat:

<div align="center">
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/live-execution.jpg" width="280" />
</div>

<p align="center"><sub>Live execution summary — tool call table · in-place patch updates for the same task<br/>Footer: project name · timestamp</sub></p>

### Task Completion Notification

When a task finishes, you get a completion card with a change summary, token usage, and duration stats. There's a text input at the bottom so you can continue the conversation right away:

<div align="center">
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/task-complete.jpg" width="280" />
&nbsp;&nbsp;&nbsp;
<img src="https://cdn.jsdelivr.net/gh/KaminDeng/agent_notifier@master/docs/images/task-complete-stats.jpg" width="280" />
</div>

<p align="center"><sub>Left: Change summary + text input to continue chatting<br/>Right: Test results table + text input to continue chatting<br/>Footer: project name · session duration · timestamp · token usage breakdown (input / output / cache read / cache write)</sub></p>

---

## 3. Supported Card Types

| Scenario | Card Color | Description |
|----------|-----------|-------------|
| Permission confirmation | Orange | Allow / Allow for Session / Deny + text input |
| AskUserQuestion (single choice) | Orange | Dynamic option buttons + Other + text input |
| AskUserQuestion (multi-part) | Orange | Q1 → Q2 → Q3 sent sequentially |
| Task complete | Green | Summary, duration, tokens + text input |
| Abnormal exit | Red | Error details + text input |
| Live execution summary | Blue | In-place patch updates for the same task |

---

## 4. Why Feishu Instead of WeChat / Telegram / Slack?

This is the question I get asked the most, so let me address it:

1. **Feishu custom apps are free** — you can create one with a personal account, and enterprise approval is instant
2. **Feishu supports long connections (WebSocket)** — no public IP or domain required. Whether you're at home, at the office, or on a VPN, it just works
3. **Feishu's interactive card system is incredibly powerful** — buttons, text inputs, tables, multi-column layouts — far beyond what a basic message notification can do
4. **Feishu syncs natively across all devices** — phone, desktop, tablet, and web all receive and can interact with the same card
5. **No need to build a separate app** — the Feishu client itself becomes your remote control

That said, the architecture uses a channel abstraction layer (`src/channels/`), so adding support for other platforms is straightforward.

---

## 5. Get Started in 5 Minutes

### Prerequisites

- Node.js >= 18
- Python 3 (for the PTY terminal relay)
- A Feishu account

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/KaminDeng/agent_notifier.git
cd agent_notifier

# 2. Edit .env with your Feishu app credentials (auto-created on first run)
#    FEISHU_APP_ID=your_app_id
#    FEISHU_APP_SECRET=your_app_secret

# 3. One-command install (handles all configuration automatically)
bash install.sh

# 4. Reload your shell
source ~/.zshrc  # or source ~/.bashrc

# 5. Use Claude Code as usual
claude
```

`install.sh` automatically takes care of:
- Installing npm dependencies
- Writing Claude Code hooks to `~/.claude/settings.json`
- Injecting `claude` / `codex` shell wrapper functions
- **Starting the Feishu listener and registering it for auto-start** (launchd on macOS, systemd on Linux)

> Running `install.sh` again is safe — it always cleans up before reinstalling.

### Feishu App Setup (3 Minutes)

1. Log in to the [Feishu Open Platform](https://open.feishu.cn) and create a custom enterprise app
2. Copy the App ID / App Secret into your `.env` file
3. Enable bot capabilities
4. Set the event subscription to **Long Connection** (no public IP needed)
5. Add the event: `card.action.trigger`
6. Request permissions: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`
7. Publish the app and add the bot to your target group

That's it. No domain, no SSL certificates, no dedicated server.

---

## 6. Cross-Platform Support

| Platform | Service Management | Auto-Start |
|----------|-------------------|------------|
| macOS | launchd | RunAtLoad + KeepAlive |
| Linux (systemd) | systemd user service | systemctl --user enable |
| Linux (SSH / no systemd) | nohup + crontab @reboot | crontab fallback |

Uninstalling is a single command:

```bash
bash uninstall.sh
```

This cleans up all configuration, stops services, and removes hooks and shell injections.

---

## 7. How It Works (Brief Overview)

There are two main pipelines:

**Claude Code Pipeline:**
```
Claude Hooks fire an event → hook-handler.js parses it → generates Feishu interactive card
                                                              ↓
User taps/types in Feishu → feishu-listener.js receives callback → injects input into local terminal
```

**Codex CLI Pipeline:**
```
pty-relay.py creates a PTY terminal proxy → captures Codex output → generates Feishu card
                                                              ↓
User taps/types in Feishu → feishu-listener.js receives callback → injects input via FIFO into terminal
```

Terminal injection supports multiple methods: tmux, PTY FIFO, pty master direct write, and TIOCSTI — the best method is auto-detected.

---

## 8. Project Structure

```
agent_notifier/
├── install.sh / uninstall.sh          # Install / uninstall
├── hook-handler.js / live-handler.js  # Claude Hooks entry points (thin shims)
├── bin/
│   └── pty-relay.py                   # PTY terminal relay
├── src/
│   ├── apps/                          # App entry points (claude-hook, claude-live, feishu-listener, etc.)
│   ├── adapters/                      # Claude / Codex adapters
│   ├── channels/                      # Feishu channel (card rendering, client, interaction handling)
│   ├── core/                          # Low-level primitives (session store, terminal injector)
│   └── lib/                           # App-level services (env config, session state, terminal inject)
├── tests/                             # 81 test cases
└── scripts/                           # Debug / test scripts
```

---

## 9. Who Is This For?

If any of the following apply to you:

- You use Claude Code or Codex CLI for daily coding
- You frequently step away from your desk and don't want tasks stalling on permission prompts
- You want to interact with your AI coding assistant from your phone
- You run multiple terminals simultaneously and need a unified notification hub

Then this tool was built for you.

---

## 10. Wrapping Up

The project is fully open source under the MIT license. Stars, forks, and issues are all welcome.

**GitHub: [https://github.com/KaminDeng/agent_notifier](https://github.com/KaminDeng/agent_notifier)**

If you find this tool useful, a star on the repo is the best way to show your support. Feel free to open an issue if you have questions or feedback.
