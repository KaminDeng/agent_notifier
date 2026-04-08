'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('../lib/env-config');

const SESSIONS_ROOT = path.join(process.env.HOME || '', '.codex', 'sessions');
const POLL_MS = 1000;

function extractLastTokenUsage(payload) {
    const usage = payload?.info?.last_token_usage;
    if (!usage || typeof usage !== 'object') return null;
    const input = Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null;
    const cached = Number.isFinite(Number(usage.cached_input_tokens)) ? Number(usage.cached_input_tokens) : null;
    const output = Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null;
    const total = Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null;
    if (input == null && cached == null && output == null && total == null) return null;
    return { input, cached, output, total };
}

function parseSessionLine(line, state = { turnId: '' }) {
    const nextState = { ...state };
    const raw = String(line || '').trim();
    if (!raw) {
        return { state: nextState, entry: null };
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return { state: nextState, entry: null };
    }

    if (data.type === 'turn_context' && data.payload?.turn_id) {
        nextState.turnId = String(data.payload.turn_id);
        return { state: nextState, entry: null };
    }

    if (data.type === 'event_msg' && data.payload?.type === 'task_started' && data.payload?.turn_id) {
        nextState.turnId = String(data.payload.turn_id);
        nextState.turnStartedAt = data.timestamp || nextState.turnStartedAt || null;
        return { state: nextState, entry: null };
    }

    if (data.type === 'event_msg' && data.payload?.type === 'token_count') {
        nextState.tokens = extractLastTokenUsage(data.payload);
        return { state: nextState, entry: null };
    }

    if (data.type !== 'response_item') {
        return { state: nextState, entry: null };
    }

    const payload = data.payload || {};
    if (payload.type !== 'message' || payload.role !== 'assistant') {
        return { state: nextState, entry: null };
    }

    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const text = blocks
        .filter((block) => block?.type === 'output_text' && String(block.text || '').trim())
        .map((block) => String(block.text).trim())
        .join('\n')
        .trim();
    if (!text) {
        return { state: nextState, entry: null };
    }

    return {
        state: nextState,
        entry: {
            text,
            assistantKey: nextState.turnId || text.slice(0, 80),
            phase: payload.phase || null,
            turnStartedAt: nextState.turnStartedAt || null,
            tokens: nextState.tokens || null,
        },
    };
}

function recoverStateFromContent(content) {
    let state = { turnId: '' };
    const lines = String(content || '').split('\n').filter(Boolean);
    for (const line of lines) {
        state = parseSessionLine(line, state).state;
    }
    return state;
}

function findLatestSessionFile(rootDir = SESSIONS_ROOT) {
    let latestPath = null;
    let latestMtime = -1;

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }
            let stat;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                continue;
            }
            if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latestPath = fullPath;
            }
        }
    }

    walk(rootDir);
    return latestPath;
}

class CodexSessionWatcher {
    constructor({ pts, installDir, projectName, liveBufferPath }) {
        this.pts = pts;
        this.installDir = installDir;
        this.projectName = projectName;
        this.liveBufferPath = liveBufferPath;
        this.currentFile = null;
        this.offset = 0;
        this.state = { turnId: '' };
        this.started = false;
    }

    tick() {
        const latest = findLatestSessionFile();
        if (!latest) return;

        if (latest !== this.currentFile) {
            this.currentFile = latest;
            this.offset = 0;
            this.state = { turnId: '' };
            try {
                const stat = fs.statSync(latest);
                const readSize = Math.min(stat.size, 65536);
                if (readSize > 0) {
                    const fd = fs.openSync(latest, 'r');
                    const buf = Buffer.alloc(readSize);
                    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
                    fs.closeSync(fd);
                    this.state = recoverStateFromContent(buf.toString('utf8'));
                }
                this.offset = stat.size;
            } catch {
                this.offset = 0;
            }
            if (!this.started) {
                this.started = true;
            }
            return;
        }

        let stat;
        try {
            stat = fs.statSync(latest);
        } catch {
            return;
        }
        if (stat.size <= this.offset) return;

        const fd = fs.openSync(latest, 'r');
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        fs.closeSync(fd);
        this.offset = stat.size;

        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            const parsed = parseSessionLine(line, this.state);
            this.state = parsed.state;
            if (!parsed.entry) continue;
            this.emitEntry(parsed.entry);
        }
    }

    emitEntry(entry) {
        fs.appendFileSync(this.liveBufferPath, JSON.stringify({
            kind: 'output',
            text: entry.text,
            assistant_key: entry.assistantKey,
            project_name: this.projectName,
            pts_device: `/dev/pts/${this.pts}`,
            ts: Date.now(),
            phase: entry.phase,
            turn_started_at: entry.turnStartedAt || null,
            tokens: entry.tokens || null,
        }) + '\n', 'utf8');

        const child = spawn('node', [
            path.join(this.installDir, 'src/apps/codex-live.js'),
            '--flush',
            this.liveBufferPath,
        ], {
            cwd: this.installDir,
            env: process.env,
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }

    start() {
        this.tick();
        setInterval(() => this.tick(), POLL_MS);
    }
}

function main() {
    const ptsIdx = process.argv.indexOf('--pts');
    const pts = ptsIdx >= 0 ? process.argv[ptsIdx + 1] : null;
    if (!pts) {
        throw new Error('需要 --pts');
    }
    const installDir = path.resolve(__dirname, '..', '..');
    const watcher = new CodexSessionWatcher({
        pts,
        installDir,
        projectName: path.basename(process.cwd()),
        liveBufferPath: `/tmp/codex-live-${pts}.jsonl`,
    });
    watcher.start();
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error('[codex-session-watcher] 启动失败:', err.message);
        process.exit(1);
    }
}

module.exports = {
    parseSessionLine,
    recoverStateFromContent,
    findLatestSessionFile,
    CodexSessionWatcher,
    extractLastTokenUsage,
};
