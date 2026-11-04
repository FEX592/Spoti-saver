'use strict';

const ANSI = {
    clear: '\x1b[2K',
    home: '\r',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
};

const stack = [];
let timer = null;
let root = null;
let rendered = false;

function interactive() {
    return !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

function enabled() {
    return !!process.stdout.isTTY;
}

function color(value, code) {
    return interactive() ? `${ANSI[code]}${value}${ANSI.reset}` : value;
}

function elapsed(startedAt) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function width() {
    return Number(process.stdout.columns) > 20 ? Number(process.stdout.columns) : 80;
}

function truncate(value, max) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function current() {
    return stack[stack.length - 1] || root;
}

function text(task, state = 'running') {
    const detail = task.detail ? ` | ${task.detail}` : '';
    const suffix = ` | ${elapsed(root.startedAt)} elapsed`;
    const prefix = state === 'success' ? '✓ ' : state === 'failure' ? '✗ ' : '● ';
    return truncate(`${prefix}${task.label}${detail}${suffix}`, width());
}

function draw() {
    if (!enabled() || !root) return;
    const task = current() || root;
    process.stdout.write(`${ANSI.home}${ANSI.clear}${text(task)}`);
    rendered = true;
}

function clearLine() {
    if (!enabled() || !rendered) return;
    process.stdout.write(`${ANSI.home}${ANSI.clear}`);
    rendered = false;
}

function start(label, options = {}) {
    const task = {
        label: String(label),
        detail: options.detail || '',
        startedAt: Date.now(),
        closed: false,
    };
    if (!root) {
        root = task;
        if (enabled()) {
            draw();
            timer = setInterval(draw, 1000);
            timer.unref?.();
        } else if (!rendered) {
            process.stdout.write(`${text(task)}\n`);
            rendered = true;
        }
    } else {
        stack.push(task);
        draw();
    }
    return {
        update(detail) {
            task.detail = detail == null ? '' : String(detail);
            draw();
        },
        success() { finish(task, 'success'); },
        fail() { finish(task, 'failure'); },
        stop() { finish(task, 'success', true); },
    };
}

function finish(task, state, silent = false) {
    if (!task || task.closed) return;
    task.closed = true;
    const nestedIndex = stack.lastIndexOf(task);
    if (nestedIndex !== -1) stack.splice(nestedIndex, 1);
    if (task !== root) {
        draw();
        return;
    }
    if (timer) clearInterval(timer);
    timer = null;
    if (enabled()) {
        if (silent) clearLine();
        else process.stdout.write(`${ANSI.home}${ANSI.clear}${text(task, state)}\n`);
    }
    root = null;
    stack.length = 0;
    rendered = false;
}

async function withStatus(label, operation, options = {}) {
    const task = start(label, options);
    try {
        const result = await operation(task);
        task.success();
        return result;
    } catch (error) {
        task.fail();
        throw error;
    }
}

function withStatusSync(label, operation, options = {}) {
    const task = start(label, options);
    try {
        const result = operation(task);
        task.success();
        return result;
    } catch (error) {
        task.fail();
        throw error;
    }
}

function update(detail) {
    current()?.update(detail);
}

function log(message, stream = process.stdout) {
    if (enabled()) clearLine();
    stream.write(`${message}\n`);
    if (root) draw();
}

function error(message) {
    log(message, process.stderr);
}

function isActive() {
    return !!root;
}

function shutdown() {
    if (timer) clearInterval(timer);
    timer = null;
    if (enabled() && rendered) clearLine();
    root = null;
    stack.length = 0;
    rendered = false;
}

process.once('exit', shutdown);

module.exports = {
    start,
    withStatus,
    withStatusSync,
    update,
    log,
    error,
    isActive,
    shutdown,
};
