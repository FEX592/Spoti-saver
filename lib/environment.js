'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');

function commandWorks(cmd, args) {
    try {
        execFileSync(cmd, args, { stdio: 'ignore' });
        return true;
    } catch (_) {
        return false;
    }
}

function termuxCommandPath(command, args) {
    if (!isTermux() || !process.env.PREFIX) return null;
    const candidate = path.join(process.env.PREFIX, 'bin', command);
    return fs.existsSync(candidate) && commandWorks(candidate, args) ? candidate : null;
}

// Termux (and any other Node-on-Android build) reports process.platform
// as 'android'. Its userland is bionic, not glibc — a standalone yt-dlp/
// ffmpeg binary built for glibc Linux will download fine and then fail
// to execute at all (wrong dynamic linker), so it must never be treated
// as a plain 'linux' target.
function isTermux() {
    return process.platform === 'android'
        || !!process.env.TERMUX_VERSION
        || /com\.termux/.test(process.env.PREFIX || '');
}

// yt-dlp publishes standalone, no-Python-required executables under these
// exact asset names on every release — this is a stable naming convention,
// not something guessed at. Linux also needs an arch check: an x86_64
// binary silently fails to run on aarch64 (Raspberry Pi, ARM servers, etc).
function ytdlpAssetName() {
    if (process.platform === 'win32') return 'yt-dlp.exe';
    if (process.platform === 'darwin') return 'yt-dlp_macos';
    return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function needsSystemInstall() {
    return isTermux() || (process.platform === 'linux' && !['x64', 'arm64'].includes(process.arch));
}

function localYtdlpPath() {
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    return path.join(BIN_DIR, name);
}

function download(url, destPath) {
    return new Promise((resolve, reject) => {
        const tempPath = `${destPath}.download`;
        console.log(`⏳ Downloading yt-dlp from ${new URL(url).hostname}...`);
        const doRequest = (u, redirects) => {
            if (redirects > 5) return reject(new Error('Too many redirects downloading ' + url));
            https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    res.resume();
                    return doRequest(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Download failed (HTTP ${res.statusCode}) for ${u}`));
                }
                const file = fs.createWriteStream(tempPath);
                const total = Number(res.headers['content-length']) || 0;
                let received = 0;
                let lastProgressAt = 0;
                res.on('data', chunk => {
                    received += chunk.length;
                    const now = Date.now();
                    if (now - lastProgressAt < 2000) return;
                    lastProgressAt = now;
                    const progress = total ? ` / ${(total / 1048576).toFixed(1)} MB (${Math.floor(received * 100 / total)}%)` : '';
                    console.log(`   Downloaded ${(received / 1048576).toFixed(1)} MB${progress}`);
                });
                res.pipe(file);
                file.on('finish', () => file.close(() => {
                    try {
                        fs.renameSync(tempPath, destPath);
                        console.log(`✅ yt-dlp download complete (${(received / 1048576).toFixed(1)} MB).`);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                }));
                file.on('error', err => {
                    try { fs.unlinkSync(tempPath); } catch (_) {}
                    reject(err);
                });
            }).on('error', reject);
        };
        doRequest(url, 0);
    });
}

// System yt-dlp if it's already on PATH, otherwise a standalone binary
// downloaded straight from yt-dlp's GitHub releases — no Python, no package
// manager, no interactive install. Cached in ./bin so it's a one-time cost.
async function resolveYtDlp() {
    const configured = process.env.YTDLP_PATH;
    if (configured && commandWorks(configured, ['--version'])) return configured;
    if (commandWorks('yt-dlp', ['--version'])) return 'yt-dlp';
    const termuxPath = termuxCommandPath('yt-dlp', ['--version']);
    if (termuxPath) return termuxPath;

    // Termux can't run the auto-downloaded glibc binary at all, so don't
    // waste time downloading one — point straight at the fix.
    if (needsSystemInstall()) {
        const platformHint = isTermux()
            ? 'Termux: pkg install yt-dlp (or pip install yt-dlp)'
            : `Linux ${process.arch}: install yt-dlp through your package manager or pip`;
        throw new Error(
            `yt-dlp not found. Install it directly for this platform: ${platformHint}`
        );
    }

    const local = localYtdlpPath();
    if (fs.existsSync(local) && commandWorks(local, ['--version'])) return local;
    if (fs.existsSync(local)) {
        console.error(`⚠️  Cached yt-dlp is not runnable at ${local} — replacing it...`);
        try { fs.unlinkSync(local); } catch (_) {}
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const asset = ytdlpAssetName();
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    await download(url, local);
    if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
    if (!commandWorks(local, ['--version'])) {
        try { fs.unlinkSync(local); } catch (_) {}
        const hint = process.platform === 'win32'
            ? 'Check that OneDrive has finished syncing the file and try again.'
            : 'Try installing yt-dlp through your package manager instead (e.g. apt install yt-dlp, or pip install yt-dlp) and re-run.';
        throw new Error(`Downloaded yt-dlp could not be run at "${local}". ${hint}`);
    }
    return local;
}

// System ffmpeg if present, otherwise the platform binary that the
// `ffmpeg-static` npm dependency already downloaded during `npm install`.
// No manual ffmpeg install ever required — except on Termux, where that
// binary exists on disk but is the wrong C library and can't run at all.
function resolveFfmpeg() {
    const configured = process.env.FFMPEG_PATH;
    if (configured && commandWorks(configured, ['-version'])) return configured;
    if (commandWorks('ffmpeg', ['-version'])) return 'ffmpeg';

    const termuxPath = termuxCommandPath('ffmpeg', ['-version']);
    if (termuxPath) return termuxPath;

    if (isTermux()) {
        throw new Error(
            'ffmpeg not found. Termux can\'t run the auto-downloaded binary (different C library), ' +
            'so install it directly instead: pkg install ffmpeg'
        );
    }

    const ffmpegStaticPath = require('ffmpeg-static');
    // Existence isn't enough — an existing-but-wrong-arch/wrong-libc binary
    // would otherwise surface as a confusing crash mid-download instead of
    // here at the upfront check.
    if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath) && commandWorks(ffmpegStaticPath, ['-version'])) {
        return ffmpegStaticPath;
    }
    throw new Error('No usable ffmpeg found (system or ffmpeg-static) — on Linux try installing it via your package manager (e.g. apt install ffmpeg) and re-run.');
}

module.exports = { resolveYtDlp, resolveFfmpeg };
