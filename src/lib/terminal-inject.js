/**
 * Terminal Input Injection
 * 向终端注入按键，用于自动响应 Claude Code 的交互式提示
 *
 * 注入策略（按优先级）:
 *   1. tmux send-keys — 如果进程运行在 tmux 中，最可靠
 *   2. FIFO 中继    — relay.js 运行时，通过 FIFO 管道传递
 *   3. pty master 写入 — 扫描 /proc 找到 pty master fd 直接写入
 *   4. TIOCSTI ioctl  — Linux 受限环境下的备用方案
 *   5. 显式 CLAUDE_TMUX_TARGET 环境变量
 *
 * 用法:
 *   const { resolveTarget, injectKeys, injectText } = require('./terminal-inject');
 *   const target = resolveTarget();
 *   await injectKeys(target, 'y');       // 发送单个字符
 *   await injectText(target, 'hello');   // 发送文本 + 回车
 */

const fs = require('fs');
const { execSync } = require('child_process');
const { createTerminalInjector } = require('../core/terminal-injector');
const { createTerminalRouter } = require('../core/terminal-router');

// ── Shell 引用辅助 ──────────────────────────────────────────

function shellQuote(str) {
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ── 终端目标解析 ────────────────────────────────────────────

/**
 * 解析当前进程对应的终端注入目标
 *
 * 返回格式:
 *   { type: 'tmux', target: 'session:window.pane' }
 *   { type: 'pts',  target: '/dev/pts/N' }
 *   null — 无法解析
 */
function resolveTarget() {
    // 策略 1: 显式环境变量
    const explicit = process.env.CLAUDE_TMUX_TARGET;
    if (explicit) return { type: 'tmux', target: explicit };

    // 策略 2: 沿进程树向上查找，同时检测 tmux 和 pts
    let pid = process.pid;
    let ptsDevice = null;

    for (let depth = 0; depth < 10; depth++) {
        // 检查 fd/0 是否指向 pts
        try {
            const fd0 = fs.readlinkSync(`/proc/${pid}/fd/0`);
            if (fd0.startsWith('/dev/pts/') && !ptsDevice) {
                ptsDevice = fd0;
            }
        } catch {}

        // 获取父进程 PID
        let ppid;
        try {
            ppid = parseInt(execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8', timeout: 2000 }).trim());
            if (!ppid || ppid <= 1) break;
        } catch { break; }

        pid = ppid;
    }

    // 策略 3: 如果找到了 pts，尝试通过 tmux 找到对应的 pane
    if (ptsDevice) {
        const tmuxTarget = findTmuxPaneByPts(ptsDevice);
        if (tmuxTarget) return { type: 'tmux', target: tmuxTarget };

        // 策略 4: 检查是否有 FIFO 中继（relay.js）
        const ptsNum = ptsDevice.replace('/dev/pts/', '');
        const fifoPath = `/tmp/agent-inject-pts${ptsNum}`;
        try {
            const stat = fs.statSync(fifoPath);
            if (stat.isFIFO()) return { type: 'fifo', target: fifoPath };
        } catch {}

        // 先回到 pts（TIOCSTI 直接调用，可能被拒绝）
        return { type: 'pts', target: ptsDevice };
    }

    return null;
}

/**
 * 通过 pts 设备路径查找对应的 tmux pane
 * 列出所有 tmux pane，匹配 pane_tty 与目标 pts
 */
function findTmuxPaneByPts(ptsDevice) {
    try {
        const output = execSync(
            "tmux list-panes -a -F '#{pane_tty} #{session_name}:#{window_index}.#{pane_index}'",
            { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();

        for (const line of output.split('\n')) {
            const [tty, target] = line.split(' ');
            if (tty === ptsDevice) return target;
        }
    } catch {}
    return null;
}

// ── pty master 查找与写入 ──────────────────────────────────

/**
 * 扫描 /proc 找到 pts 设备对应的 pty master fd
 * 利用 /proc/{pid}/fdinfo/{fd} 中的 tty-index 字段匹配
 * @returns {{ pid: string, fd: string, path: string } | null}
 */
function findPtyMaster(ptsDevice) {
    const ptsNum = ptsDevice.replace('/dev/pts/', '');
    try {
        const pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
        for (const pid of pids) {
            let fds;
            try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
            for (const fd of fds) {
                try {
                    const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                    if (link !== '/dev/ptmx' && !link.startsWith('/dev/pts/ptmx')) continue;
                    const fdinfo = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
                    const match = fdinfo.match(/tty-index:\s*(\d+)/);
                    if (match && match[1] === ptsNum) {
                        return { pid, fd, path: `/proc/${pid}/fd/${fd}` };
                    }
                } catch { continue; }
            }
        }
    } catch {}
    return null;
}

/**
 * 通过 pty master 写入注入按键
 * 写入 pty master 等效于用户键盘输入
 */
function injectViaPtyMaster(ptsDevice, keys) {
    const master = findPtyMaster(ptsDevice);
    if (!master) {
        throw new Error(`找不到 ${ptsDevice} 对应的 pty master`);
    }
    const fd = fs.openSync(master.path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try {
        fs.writeSync(fd, keys);
    } finally {
        fs.closeSync(fd);
    }
    return true;
}

// ── 按键注入 ────────────────────────────────────────────────

/**
 * 向终端注入按键序列
 *
 * @param {{ type: string, target: string } | null} target - resolveTarget() 的返回值
 * @param {string} keys - 要注入的按键字符串
 * @returns {Promise<boolean>}
 */
async function injectKeys(target, keys) {
    if (!target) throw new Error('No terminal target resolved');

    // 字符串目标自动转为 target 对象
    if (typeof target === 'string') {
        if (target.startsWith('tmux:')) {
            target = { type: 'tmux', target: target.substring(5) };
        } else if (target.startsWith('fifo:')) {
            target = { type: 'fifo', target: target.substring(5) };
        } else if (target.startsWith('/dev/pts/')) {
            target = { type: 'pts', target: target };
        } else {
            throw new Error(`Unknown target format: ${target}`);
        }
    }

    if (target.type === 'tmux') {
        return injectViaTmux(target.target, keys);
    }

    if (target.type === 'fifo') {
        try {
            return injectViaFifo(target.target, keys);
        } catch (fifoErr) {
            // FIFO 写入失败（relay 未运行），从路径提取 pts 编号，尝试 pty master
            const match = target.target.match(/agent-inject-pts(\d+)$/);
            if (match) {
                const ptsDevice = `/dev/pts/${match[1]}`;
                try {
                    return injectViaPtyMaster(ptsDevice, keys);
                } catch {}
            }
            throw fifoErr;
        }
    }

    if (target.type === 'pts') {
        // 先检查 FIFO 中继
        const ptsNum = target.target.replace('/dev/pts/', '');
        const fifoPath = `/tmp/agent-inject-pts${ptsNum}`;
        try {
            if (fs.statSync(fifoPath).isFIFO()) {
                return injectViaFifo(fifoPath, keys);
            }
        } catch {}

        // 再尝试 pty master 写入（现代方案）
        try {
            return injectViaPtyMaster(target.target, keys);
        } catch {}

        // 最后再尝试 TIOCSTI
        try {
            return injectViaTiocsti(target.target, keys);
        } catch (tiocErr) {
            const tmuxTarget = findTmuxPaneByPts(target.target);
            if (tmuxTarget) {
                return injectViaTmux(tmuxTarget, keys);
            }
            throw new Error(`无法注入终端。请在 tmux 中启动 Claude Code，或使用 pty-relay.py 建立终端桥接。具体错误: ${tiocErr.message}`);
        }
    }

    throw new Error(`Unknown target type: ${target.type}`);
}

/**
 * 通过 FIFO 中继注入（配合 pty-relay.py / relay.js 使用）
 * 使用 base64 编码保留 \n 等控制字符
 */
function injectViaFifo(fifoPath, keys) {
    try {
        const encoded = Buffer.from(keys).toString('base64');
        fs.writeFileSync(fifoPath, encoded + '\n');
        return true;
    } catch (err) {
        throw new Error(`FIFO 写入失败: ${err.message}`);
    }
}

/**
 * 通过 tmux send-keys 注入
 */
function injectViaTmux(target, keys) {
    // 逐字符处理特殊键
    const parts = [];
    for (const ch of keys) {
        if (ch === '\n' || ch === '\r') parts.push('Enter');
        else if (ch === '\x1b') parts.push('Escape');
        else if (ch === '\t') parts.push('Tab');
        else parts.push(shellQuote(ch));
    }

    const cmd = `tmux send-keys -t ${shellQuote(target)} ${parts.join(' ')}`;
    try {
        execSync(cmd, { timeout: 5000, stdio: 'pipe' });
        return true;
    } catch (err) {
        throw new Error(`tmux send-keys failed: ${err.message}`);
    }
}

/**
 * 通过 TIOCSTI ioctl 逐字符注入
 */
function injectViaTiocsti(ptsDevice, keys) {
    if (!ptsDevice.startsWith('/dev/pts/')) {
        throw new Error(`Invalid pts device path: ${ptsDevice}`);
    }

    const keysJson = JSON.stringify(keys);
    const ptsDeviceJson = JSON.stringify(ptsDevice);
    const pythonScript = [
        'import fcntl, termios, json',
        `keys = json.loads(${JSON.stringify(keysJson)})`,
        `fd = open(json.loads(${JSON.stringify(ptsDeviceJson)}), "w")`,
        'try:',
        '    for c in keys:',
        '        fcntl.ioctl(fd, termios.TIOCSTI, c.encode())',
        'finally:',
        '    fd.close()',
    ].join('\n');

    execSync(`python3 -c ${shellQuote(pythonScript)}`, { timeout: 5000, stdio: 'pipe' });
    return true;
}

// ── 文本注入 ────────────────────────────────────────────────

async function injectText(target, text) {
    return sharedTerminalInjector.deliver({ responseType: 'text', value: text }, target);
}

// ── 旧接口包装 ────────────────────────────────────────────────

/** @deprecated 使用 resolveTarget() 代替 */
function resolvePtsDevice(startPid) {
    const target = resolveTarget();
    if (!target) return null;
    if (target.type === 'tmux') return `tmux:${target.target}`;
    if (target.type === 'fifo') return `fifo:${target.target}`;
    return target.target;
}

function injectTextRaw(target, text) {
    return injectKeys(target, text);
}

const sharedTerminalInjector = createTerminalInjector({ injectText: injectTextRaw });

module.exports = {
    resolveTarget,
    resolvePtsDevice,
    injectKeys,
    injectText,
    createTerminalInjector,
    createTerminalRouter,
};
