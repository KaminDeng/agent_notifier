#!/usr/bin/env python3
"""
PTY 代理中继 — 非 tmux 环境下的终端输入注入方案

在终端中运行，创建 pty 代理层：
    终端 <-> pty-relay (持有 master fd) <-> shell / Claude Code
                 ^
           FIFO 接收注入

用法:
    python3 pty-relay.py                  # 默认启动 $SHELL (zsh)
    python3 pty-relay.py bash             # 指定 shell
    python3 pty-relay.py claude --flags   # 直接运行指定命令

原理:
    1. 创建 pty pair (master/slave)
    2. 在 slave 端启动 shell，relay 持有 master fd
    3. 代理终端 <-> pty master 的所有 I/O
    4. 创建 FIFO: /tmp/agent-inject-pts{N}，监听注入指令
    5. 收到注入指令后写入 master fd = 等效键盘输入

可直接配合现有 hook-handler / feishu-listener 使用，
无需 TIOCSTI，也无需 tmux。
"""

import os
import sys
import pty
import select
import signal
import tty
import termios
import struct
import fcntl
import threading
import time
import base64
import json
import re
import subprocess
from collections import deque


# ── 加载 .env ──────────────────────────────────────────────
def _load_dotenv():
    """从脚本同目录的 .env 文件加载环境变量（不覆盖已有变量）"""
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass

_load_dotenv()


def get_winsize(fd):
    """获取终端窗口大小"""
    try:
        buf = fcntl.ioctl(fd, termios.TIOCGWINSZ, b'\x00' * 8)
        rows, cols = struct.unpack('HHHH', buf)[:2]
        return rows, cols
    except Exception:
        return 24, 80


def set_winsize(fd, rows, cols):
    """设置终端窗口大小"""
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main():
    # 解析命令: 支持任意命令或默认 shell
    if len(sys.argv) > 1:
        cmd = sys.argv[1:]
    else:
        shell = os.environ.get('SHELL', '/bin/zsh')
        cmd = [shell, '-i']

    if not os.isatty(0):
        print('[pty-relay] 请在终端中运行此脚本（需要 TTY 环境）', file=sys.stderr)
        sys.exit(1)

    # 保存原始终端设置
    orig_tty = termios.tcgetattr(0)
    rows, cols = get_winsize(0)

    # 创建 pty pair
    master_fd, slave_fd = os.openpty()
    slave_name = os.ttyname(slave_fd)
    pts_num = slave_name.rsplit('/', 1)[-1]

    # 设置 slave 终端大小
    set_winsize(slave_fd, rows, cols)

    # 创建 FIFO
    fifo_path = f'/tmp/agent-inject-pts{pts_num}'
    try:
        os.unlink(fifo_path)
    except FileNotFoundError:
        pass
    os.mkfifo(fifo_path)
    print(f'\r\033[36m⚡ [AGENT_NOTIFIER]\033[0m PTY relay active', file=sys.stderr)
    print(f'  \033[90m├─ pty:  {slave_name}\033[0m', file=sys.stderr)
    print(f'  \033[90m└─ fifo: {fifo_path}\033[0m', file=sys.stderr)

    # Fork 子进程运行 shell
    pid = os.fork()
    if pid == 0:
        # 子进程 — 在 slave 端运行 shell
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        os.execvp(cmd[0], cmd)
        sys.exit(1)

    # 父进程 — 代理 I/O
    os.close(slave_fd)

    # 设置终端 raw 模式
    tty.setraw(0)

    running = True

    # FIFO 监听线程
    def fifo_reader():
        while running:
            try:
                fifo_fd = os.open(fifo_path, os.O_RDONLY)
                buf = b''
                while running:
                    data = os.read(fifo_fd, 4096)
                    if not data:
                        break
                    buf += data
                    # 按行处理（每行是 base64 编码的按键序列）
                    while b'\n' in buf:
                        line, buf = buf.split(b'\n', 1)
                        if line:
                            try:
                                decoded = base64.b64decode(line)
                                os.write(master_fd, decoded)
                            except Exception:
                                pass
                os.close(fifo_fd)
            except OSError:
                if not running:
                    break
                time.sleep(0.5)

    fifo_thread = threading.Thread(target=fifo_reader, daemon=True)
    fifo_thread.start()

    # 处理窗口大小变化
    def on_winch(signum, frame):
        r, c = get_winsize(0)
        try:
            set_winsize(master_fd, r, c)
        except OSError:
            pass

    signal.signal(signal.SIGWINCH, on_winch)

    # 终端输出缓冲文件（供 hook-handler 读取权限选项）
    output_log_path = f'/tmp/claude-pty-output-{pts_num}'
    output_buffer = bytearray()
    OUTPUT_BUFFER_MAX = 4096
    assistant_feed_path = '/tmp/codex-assistant-feed.jsonl'
    live_buffer_path = f'/tmp/codex-live-{pts_num}.jsonl'
    last_feed_ts = 0.0
    last_feed_sig = ''
    feed_lines = []
    current_assistant_key = ''
    user_input_buf = ''
    recent_user_inputs = deque(maxlen=40)
    FEED_INTERVAL_SEC = 2.0
    FEED_MAX_LINES = 0
    install_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    capture_raw = os.environ.get('FEISHU_LIVE_CAPTURE', '').strip()
    if capture_raw.lower() in ('1', 'true', 'all', 'yes'):
        capture = {'tools': True, 'output': True, 'results': True}
    elif capture_raw:
        parts = {item.strip().lower() for item in capture_raw.split(',') if item.strip()}
        capture = {
            'tools': 'tools' in parts,
            'output': 'output' in parts,
            'results': 'results' in parts,
        }
    else:
        capture = None
    session_watcher_started = False

    def maybe_start_session_watcher():
        nonlocal session_watcher_started
        if session_watcher_started:
            return
        if not capture or not capture.get('output'):
            return
        try:
            subprocess.Popen(
                ['node', os.path.join(install_dir, 'src/apps/codex-session-watcher.js'), '--pts', str(pts_num)],
                cwd=install_dir,
                env=os.environ.copy(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            session_watcher_started = True
        except Exception:
            pass

    ansi_csi = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
    ansi_osc = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
    orphan_csi = re.compile(r'(?:^|[\s(])\[[0-9;?]*[ -/]*[@-~]')
    ctrl = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
    meaningful = re.compile(r'[A-Za-z0-9\u4e00-\u9fff]')
    noise = re.compile(r'^(?:working|thinking|pending|loading|ok|okay|wait|please wait)$', re.IGNORECASE)

    def normalize_line(text):
        return re.sub(r'\s+', ' ', text).strip()

    def clean_text(text):
        t = ansi_osc.sub('', text)
        t = ansi_csi.sub('', t)
        t = orphan_csi.sub(' ', t)
        t = t.replace('\r', '\n')
        t = ctrl.sub('', t)
        return t

    def remember_user_input(raw):
        nonlocal user_input_buf, current_assistant_key
        if not raw:
            return
        txt = raw.decode('utf-8', errors='ignore').replace('\r', '\n')
        user_input_buf += txt
        while '\n' in user_input_buf:
            line, user_input_buf = user_input_buf.split('\n', 1)
            n = normalize_line(line)
            if n:
                recent_user_inputs.append((n, time.time()))
                # 用户发起新输入后，下一段助手输出视为新任务
                current_assistant_key = ''

    def looks_like_user_echo(line):
        n = normalize_line(line)
        if not n:
            return False
        now = time.time()
        for item, ts in list(recent_user_inputs):
            if now - ts > 180:
                continue
            if n == item:
                return True
            # 某些 TUI 会在前面加提示符再回显输入
            if n.endswith(item) and (n.startswith('❯') or n.startswith('>') or n.startswith('›')):
                return True
        return False

    def maybe_emit_feed():
        nonlocal last_feed_ts, last_feed_sig, feed_lines, current_assistant_key
        if not feed_lines:
            return
        now = time.time()
        if now - last_feed_ts < FEED_INTERVAL_SEC:
            return
        if FEED_MAX_LINES and FEED_MAX_LINES > 0:
            text = '\n'.join(feed_lines[-FEED_MAX_LINES:]).strip()
        else:
            text = '\n'.join(feed_lines).strip()
        if not text:
            return
        sig = f"{len(text)}:{text[-300:]}"
        if sig == last_feed_sig:
            return
        payload = {
            'pts_device': slave_name,
            'text': text,
            'assistant_key': current_assistant_key or normalize_line(text)[:80],
            'project_name': os.path.basename(os.getcwd()),
            'ts': int(now * 1000),
        }
        try:
            if capture and not capture.get('output') and (capture.get('tools') or capture.get('results')):
                with open(live_buffer_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps({
                        'kind': 'output',
                        'text': text,
                        'assistant_key': payload['assistant_key'],
                        'project_name': payload['project_name'],
                        'pts_device': slave_name,
                        'ts': payload['ts'],
                    }, ensure_ascii=False) + '\n')
                subprocess.Popen(
                    ['node', os.path.join(install_dir, 'src/apps/codex-live.js'), '--flush', live_buffer_path],
                    cwd=install_dir,
                    env=os.environ.copy(),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            elif capture is None:
                with open(assistant_feed_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(payload, ensure_ascii=False) + '\n')
            last_feed_sig = sig
            last_feed_ts = now
            feed_lines = []
        except Exception:
            pass

    def save_output(chunk):
        nonlocal output_buffer, feed_lines, current_assistant_key
        output_buffer.extend(chunk)
        if len(output_buffer) > OUTPUT_BUFFER_MAX:
            output_buffer = output_buffer[-OUTPUT_BUFFER_MAX:]
        try:
            with open(output_log_path, 'wb') as f:
                f.write(output_buffer)
        except Exception:
            pass

        try:
            cleaned = clean_text(chunk.decode('utf-8', errors='ignore'))
            for line in cleaned.split('\n'):
                s = line.strip()
                if len(s) < 6:
                    continue
                if not meaningful.search(s):
                    continue
                if noise.match(s):
                    continue
                if looks_like_user_echo(s):
                    continue
                # 跳过明显的终端状态行，减少噪声推送
                if s.startswith('Context ') or s.startswith('Press Ctrl-C'):
                    continue
                if s.startswith('❯') or s.startswith('>') or s.startswith('›'):
                    continue
                if not current_assistant_key:
                    current_assistant_key = normalize_line(s)[:80]
                feed_lines.append(s)
            if len(feed_lines) > 30:
                feed_lines = feed_lines[-30:]
            maybe_emit_feed()
        except Exception:
            pass

    maybe_start_session_watcher()

    # 主 I/O 循环（raw 模式下 Ctrl-C 直接作为字节传给 master）
    try:
        while True:
            try:
                rfds, _, _ = select.select([0, master_fd], [], [], 1.0)
            except (select.error, InterruptedError):
                continue

            if 0 in rfds:
                data = os.read(0, 4096)
                if not data:
                    break
                remember_user_input(data)
                os.write(master_fd, data)

            if master_fd in rfds:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    os.write(1, data)
                    save_output(data)
                except OSError:
                    break
    except Exception:
        pass
    finally:
        running = False
        # 恢复终端设置
        try:
            termios.tcsetattr(0, termios.TCSAFLUSH, orig_tty)
        except Exception:
            pass
        # 清理 FIFO
        try:
            os.unlink(fifo_path)
        except Exception:
            pass
        # 终止子进程
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except Exception:
            pass
        print('\r\033[36m⚡ [AGENT_NOTIFIER]\033[0m PTY relay stopped', file=sys.stderr)


if __name__ == '__main__':
    main()
