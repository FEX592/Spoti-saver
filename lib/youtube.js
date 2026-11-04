'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATUS_INTERVAL = 1000;
function paint(text, code, stream = process.stdout) {
    if (!stream.isTTY || process.env.NO_COLOR || process.env.TERM === 'dumb') return text;
    return `\x1b[${code}m${text}\x1b[0m`;
}

function elapsedText(startedAt) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function createStatus(label) {
    const startedAt = Date.now();
    let detail = 'working';
    const enabled = !!process.stdout.isTTY;
    const render = () => {
        if (enabled) {
            const detailColor = /\d+(?:\.\d+)?%/.test(detail) ? 32 : 33;
            process.stdout.write(`\r\x1b[K${paint(label, 36)} | ${paint(detail, detailColor)} | ${paint(`elapsed ${elapsedText(startedAt)}`, 2)}`);
        }
    };
    const timer = enabled ? setInterval(render, STATUS_INTERVAL) : null;
    if (enabled) render(); else console.log(`${label}...`);
    return {
        update(value) { detail = value; render(); },
        stop() {
            if (timer) clearInterval(timer);
            if (enabled) process.stdout.write('\r\x1b[K');
        },
    };
}

function runYtDlpCapture(ytdlpPath, args, label = 'Searching YouTube') {
    return new Promise((resolve, reject) => {
        const status = createStatus(label);
        const proc = spawn(ytdlpPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', data => { stdout += data; });
        proc.stderr.on('data', data => { stderr += data; });
        proc.on('error', error => { status.stop(); reject(error); });
        proc.on('close', code => {
            status.stop();
            if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
            resolve(stdout);
        });
    });
}

// Keep routine yt-dlp metadata and transfer progress quiet, but let actual
// errors through so a failed download remains diagnosable.
function makeErrorFilter(outStream, status) {
    let buffer = '';
    return chunk => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop();
        for (const line of lines) {
            const text = line.trim();
            const progress = text.match(/\[download\]\s+(\d+(?:\.\d+)?%)/i);
            const eta = text.match(/\bETA\s+([0-9:]+)/i);
            if (progress) status.update(`${progress[1]}${eta ? ` | ETA ${eta[1]}` : ''}`);
            else if (/\[(?:ExtractAudio|Merger|Fixup[^\]]*)\]/i.test(text)) status.update('converting audio');
            if (/^ERROR:/i.test(text)) {
                status.stop();
                outStream.write(`${line}\n`);
            }
        }
    };
}

function runYtDlp(ytdlpPath, args, label = 'Downloading') {
    return new Promise((resolve, reject) => {
        const proc = spawn(ytdlpPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let lastOutputAt = Date.now();
        let timedOut = false;
        const status = createStatus(label);
        const idleLimit = 180000;
        const stdoutFilter = makeErrorFilter(process.stdout, status);
        const stderrFilter = makeErrorFilter(process.stderr, status);
        const watchdog = setInterval(() => {
            const idleSeconds = Math.floor((Date.now() - lastOutputAt) / 1000);
            if (idleSeconds < idleLimit / 1000) return;
            timedOut = true;
            status.stop();
            console.error(paint(`yt-dlp stopped producing output for ${idleSeconds}s; stopping the download.`, 31, process.stderr));
            proc.kill();
            setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000).unref();
        }, STATUS_INTERVAL);
        proc.stdout.on('data', data => { lastOutputAt = Date.now(); stdoutFilter(data); });
        proc.stderr.on('data', data => { lastOutputAt = Date.now(); stderrFilter(data); });
        proc.on('error', error => { clearInterval(watchdog); status.stop(); reject(error); });
        proc.on('close', code => {
            clearInterval(watchdog);
            status.stop();
            if (timedOut) return reject(new Error('yt-dlp download timed out after 180 seconds without output. Check the network connection and try again.'));
            code === 0 ? resolve() : reject(new Error(`yt-dlp exited with code ${code}`));
        });
    });
}

async function findBestMatch(ytdlpPath, title, artist, targetDurationMs) {
    const artists = String(artist || '').split(',').map(value => value.trim()).filter(Boolean);
    const queries = [...new Set([
        [title, artist].filter(Boolean).join(' '),
        [title, artists[0]].filter(Boolean).join(' '),
        String(title || '').trim(),
    ].filter(Boolean))];

    let candidates = [];
    for (const query of queries) {
        try {
            const searchLabel = `Searching YouTube: ${query.slice(0, 40)}`;
            const stdout = await runYtDlpCapture(ytdlpPath, ['--dump-json', '--no-warnings', `ytsearch5:${query}`], searchLabel);
            candidates = stdout.split('\n').map(line => line.trim()).filter(Boolean)
                .map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
            if (candidates.length) break;
        } catch (_) {
            // Retry with a less specific query; report one error only if all fail.
        }
    }

    if (!candidates.length) throw new Error(`No YouTube results for "${queries[0] || title}"`);
    if (!targetDurationMs) return candidates[0];
    const targetSeconds = targetDurationMs / 1000;
    candidates.sort((a, b) => Math.abs((a.duration || 0) - targetSeconds) - Math.abs((b.duration || 0) - targetSeconds));
    return candidates[0];
}

function ffmpegLocation(ffmpegPath) {
    // Pass the containing directory so yt-dlp can find ffprobe alongside ffmpeg.
    return path.dirname(ffmpegPath);
}

async function downloadAudio(ytdlpPath, ffmpegPath, youtubeUrl, outputPathNoExt, title = '') {
    const label = title ? `Downloading ${title}` : 'Downloading';
    await runYtDlp(ytdlpPath, [
        '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '--no-playlist', '--no-warnings', '--ffmpeg-location', ffmpegLocation(ffmpegPath),
        '-o', `${outputPathNoExt}.%(ext)s`, youtubeUrl,
    ], label);

    const expected = `${outputPathNoExt}.mp3`;
    if (fs.existsSync(expected)) return expected;
    const dir = path.dirname(outputPathNoExt);
    const base = path.basename(outputPathNoExt);
    const found = fs.readdirSync(dir).find(file => file.startsWith(`${base}.`));
    if (!found) throw new Error('yt-dlp finished but no output file was found.');
    const recovered = path.join(dir, found);
    fs.renameSync(recovered, expected);
    return expected;
}

module.exports = { findBestMatch, downloadAudio };
