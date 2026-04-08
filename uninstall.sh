#!/usr/bin/env bash
#
# Claude/Codex CLI 通知系统 - 卸载脚本
# 停止服务、移除 hooks、清理 shell 注入和运行时文件
#

set -euo pipefail

# ── 颜色定义 ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── 安装目录 ─────────────────────────────────────────────
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

info()    { echo -e "${BLUE}[信息]${NC} $1"; }
success() { echo -e "${GREEN}[成功]${NC} $1"; }
warn()    { echo -e "${YELLOW}[警告]${NC} $1"; }
error()   { echo -e "${RED}[错误]${NC} $1"; }

echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Claude/Codex CLI 通知系统 - 卸载${NC}"
echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
echo ""

# ── 0. 停止并移除持久化服务 ─────────────────────────────
info "正在停止持久化服务..."

PLIST_LABEL="com.agent-notifier.feishu-listener"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SYSTEMD_SERVICE="agent-notifier-feishu.service"
SYSTEMD_FILE="$HOME/.config/systemd/user/$SYSTEMD_SERVICE"
CRON_MARKER="# agent-notifier-feishu"

if [[ "$OSTYPE" == darwin* ]]; then
    # ── macOS: launchd ──
    if [ -f "$PLIST_FILE" ]; then
        launchctl bootout "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
        rm -f "$PLIST_FILE"
        success "已停止并移除 launchd 服务"
    else
        info "launchd 服务未安装，跳过"
    fi
else
    # ── Linux: systemd + crontab ──
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

    if systemctl --user is-enabled "$SYSTEMD_SERVICE" &>/dev/null 2>&1; then
        systemctl --user stop "$SYSTEMD_SERVICE" 2>/dev/null || true
        systemctl --user disable "$SYSTEMD_SERVICE" 2>/dev/null || true
        success "已停止并禁用 systemd 服务"
    else
        info "systemd 服务未安装，跳过"
    fi
    rm -f "$SYSTEMD_FILE"
    systemctl --user daemon-reload 2>/dev/null || true

    # 清理 crontab @reboot 条目
    if crontab -l 2>/dev/null | grep -q "$CRON_MARKER"; then
        crontab -l 2>/dev/null | grep -v "$CRON_MARKER" | crontab -
        success "已移除 crontab @reboot 条目"
    fi
fi

echo ""

# ── 1. 停止后台服务 ─────────────────────────────────────
info "正在停止后台服务..."

# 通过 PID 文件停止 feishu-listener
if [ -f "$INSTALL_DIR/feishu-listener.pid" ]; then
    PID=$(cat "$INSTALL_DIR/feishu-listener.pid" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        success "已停止 feishu-listener (PID: $PID)"
    else
        info "feishu-listener 未在运行"
    fi
    rm -f "$INSTALL_DIR/feishu-listener.pid"
else
    # 尝试 pkill 兜底
    if pkill -f "node ${INSTALL_DIR}/feishu-listener.js" 2>/dev/null ||
       pkill -f "node feishu-listener.js" 2>/dev/null; then
        success "已停止 feishu-listener (pkill)"
    fi
fi

# 通过 PID 文件停止 codex-watcher
if [ -f "$INSTALL_DIR/codex-watcher.pid" ]; then
    PID=$(cat "$INSTALL_DIR/codex-watcher.pid" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        success "已停止 codex-watcher (PID: $PID)"
    else
        info "codex-watcher 未在运行"
    fi
    rm -f "$INSTALL_DIR/codex-watcher.pid"
else
    if pkill -f "node ${INSTALL_DIR}/src/apps/codex-watcher.js" 2>/dev/null; then
        success "已停止 codex-watcher (pkill)"
    fi
fi

# 停止本项目的 codex-session-watcher（限定路径避免误杀）
if pkill -f "node ${INSTALL_DIR}/src/apps/codex-session-watcher.js" 2>/dev/null; then
    success "已停止 codex-session-watcher"
fi

# 停止本项目的 pty-relay（限定路径避免误杀）
if pkill -f "python3 ${INSTALL_DIR}/bin/pty-relay.py" 2>/dev/null; then
    success "已停止 pty-relay"
fi

echo ""

# ── 2. 移除 Claude Code Hooks ───────────────────────────
info "正在移除 Claude Code Hooks..."

SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
    node -e "
const fs = require('fs');
const settingsPath = '$SETTINGS_FILE';
const installDir = '$INSTALL_DIR';

let settings;
try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
    process.exit(0);
}

if (!settings.hooks) {
    console.log('  无 hooks 需要移除');
    process.exit(0);
}

let changed = false;

for (const [event, rules] of Object.entries(settings.hooks)) {
    if (!Array.isArray(rules)) continue;
    const before = rules.length;
    settings.hooks[event] = rules.filter(rule => {
        if (!rule.hooks || !Array.isArray(rule.hooks)) return true;
        // 移除包含本项目路径的 hook
        const hasOurs = rule.hooks.some(h =>
            h.command && h.command.includes(installDir)
        );
        return !hasOurs;
    });
    const removed = before - settings.hooks[event].length;
    if (removed > 0) {
        changed = true;
        console.log('  - 移除 Hook: ' + event + ' (' + removed + ' 条)');
    }
    // 清理空数组
    if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
    }
}

// 如果 hooks 对象为空则删除
if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
}

if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
} else {
    console.log('  无 hooks 需要移除');
}
"
    success "Claude Code Hooks 已清理"
else
    info "未找到 $SETTINGS_FILE，跳过"
fi

echo ""

# ── 3. 移除 shell 函数注入 ──────────────────────────────
info "正在移除 shell 函数注入..."

remove_shell_injection() {
    local rc_file="$1"
    if [ ! -f "$rc_file" ]; then
        return
    fi
    if ! grep -q "Claude Code PTY 中继" "$rc_file" 2>/dev/null; then
        return
    fi

    # 使用 sed 删除注入块（从开始标记到结束标记）
    # Claude Code PTY 中继块
    sed -i '/^# ── Claude Code PTY 中继（由 claude-notifier 安装脚本注入） ──$/,/^# ── Claude Code PTY 中继结束 ──$/d' "$rc_file"
    # Codex CLI PTY 中继块
    sed -i '/^# ── Codex CLI PTY 中继（由 claude-notifier 安装脚本注入） ──$/,/^# ── Codex CLI PTY 中继结束 ──$/d' "$rc_file"

    # 清理可能残留的连续空行（最多保留一个）
    sed -i '/^$/N;/^\n$/d' "$rc_file"

    success "已从 $rc_file 移除 shell 函数"
}

remove_shell_injection "$HOME/.zshrc"
remove_shell_injection "$HOME/.bashrc"

echo ""

# ── 4. 清理运行时文件 ───────────────────────────────────
info "正在清理运行时文件..."

# 项目内运行时文件
for f in session-state.json session-state.json.tmp \
         feishu-listener.pid feishu-listener.log \
         codex-watcher.pid codex-watcher.log; do
    if [ -f "$INSTALL_DIR/$f" ]; then
        rm -f "$INSTALL_DIR/$f"
        info "  删除 $f"
    fi
done

# /tmp 运行时文件
for pattern in agent-inject-pts claude-pty-output- claude-live- codex-live-; do
    for f in /tmp/${pattern}*; do
        if [ -f "$f" ] || [ -p "$f" ]; then
            rm -f "$f"
            info "  删除 $f"
        fi
    done
done
rm -f /tmp/codex-assistant-feed.jsonl
rm -f /tmp/ask-handler-diag.log

success "运行时文件已清理"
echo ""

# ── 完成 ────────────────────────────────────────────────
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  卸载完成！${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
info "已保留: .env (用户配置), node_modules/ (依赖)"
info "如需完全清除，请手动执行:"
echo "  rm -f $INSTALL_DIR/.env"
echo "  rm -rf $INSTALL_DIR/node_modules"
echo ""
