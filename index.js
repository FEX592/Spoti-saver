#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawn } = require('child_process');

const ROOT = __dirname;
function paint(text, code, stream = process.stdout) {
    if (!stream.isTTY || process.env.NO_COLOR || process.env.TERM === 'dumb') return text;
    return `\x1b[${code}m${text}\x1b[0m`;
}

// Termux normally sets this, but launchers, file managers, and some shells can
// start Node without exporting $PREFIX/bin. Put the native package directory
// first so every child process—including yt-dlp's ffprobe lookup—can find it.
if (process.env.PREFIX) {
    const termuxBin = path.join(process.env.PREFIX, 'bin');
    const pathParts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (!pathParts.includes(termuxBin)) process.env.PATH = [termuxBin, ...pathParts].join(path.delimiter);
    // These are process-local on purpose: a child script cannot export into
    // the parent Termux shell, but the downloader and every child it starts
    // can use these absolute paths reliably.
    process.env.YTDLP_PATH = process.env.YTDLP_PATH || path.join(termuxBin, 'yt-dlp');
    process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || path.join(termuxBin, 'ffmpeg');
    process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || path.join(termuxBin, 'ffprobe');
}

function isTermuxRuntime() {
    return process.platform === 'android'
        || !!process.env.TERMUX_VERSION
        || /com\.termux/.test(process.env.PREFIX || '');
}

function commandAvailable(command) {
    try {
        execSync(`command -v ${command}`, { stdio: 'ignore', shell: '/bin/sh' });
        return true;
    } catch (_) {
        // Some Termux launches do not expose $PREFIX/bin to child shells even
        // though the native package is installed. Check the canonical path as
        // a fallback so we do not continue with a missing tool.
        const prefixBin = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', command) : null;
        return !!prefixBin && fs.existsSync(prefixBin);
    }
}

async function ensurePlatformTools() {
    const missing = ['yt-dlp', 'ffmpeg', 'ffprobe'].filter(command => !commandAvailable(command));
    const bootstrap = path.join(ROOT, 'bootstrap.js');
    if (!fs.existsSync(bootstrap)) {
        throw new Error(`Missing tools: ${missing.join(', ')}. The project bootstrap.js file is missing.`);
    }
    const args = [bootstrap];
    // Interactive terminals get the platform/distro selection wizard. Piped
    // or headless launches use safe OS/package-manager auto-detection instead.
    if (!process.stdin.isTTY || !process.stdout.isTTY) args.push('--auto');
    await runQuietly(`"${process.execPath}" ${args.map(value => `"${value}"`).join(' ')}`, { cwd: ROOT }, 'Checking yt-dlp and FFmpeg');
}

function runQuietly(command, options = {}, label = 'Working') {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(command, [], { ...options, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const interactive = !!process.stdout.isTTY;
        const render = () => {
            if (!interactive) return;
            const seconds = Math.floor((Date.now() - startedAt) / 1000);
            process.stdout.write(`\r\x1b[K${paint(label, 36)} | ${paint(`elapsed ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, 2)}`);
        };
        if (interactive) render(); else console.log(`${label}...`);
        const timer = interactive ? setInterval(render, 1000) : null;
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.on('error', error => {
            if (timer) clearInterval(timer);
            if (interactive) process.stdout.write('\r\x1b[K');
            reject(error);
        });
        child.on('close', code => {
            if (timer) clearInterval(timer);
            if (interactive) process.stdout.write('\r\x1b[K');
            if (code === 0) return resolve();
            const output = [stdout, stderr].filter(Boolean).map(value => value.toString().trim()).filter(Boolean).join('\n');
            if (output) console.error(output);
            reject(new Error(`Setup command failed${code == null ? '' : ` (exit ${code})`}.`));
        });
    });
}

// ── Step 1: npm deps ─────────────────────────────────────────────────────
// This has to happen with zero external requires (fs/path/child_process
// only), because spotifyApi.js/tagger.js need axios/node-id3 at their own
// top level — if we required them before this check, a fresh clone would
// crash on MODULE_NOT_FOUND before ever getting a chance to self-heal.
async function ensureNpmDeps() {
    const required = ['axios', 'node-id3', 'ffmpeg-static', 'dotenv'];
    const missing = required.filter(pkg => !fs.existsSync(path.join(ROOT, 'node_modules', pkg)));
    if (missing.length) {
        // ffmpeg-static has no Termux/Android binary and its install script
        // aborts npm install. Termux uses the native pkg ffmpeg package.
        const installCommand = isTermuxRuntime() ? 'npm install --ignore-scripts --silent --no-audit --no-fund' : 'npm install --silent --no-audit --no-fund';
        await runQuietly(installCommand, { cwd: ROOT }, 'Installing Node.js packages');
    }
}
let spotify, youtube, env, config, tagFile, sanitizeFilename, ensureDir, formatDuration;

function clearTerminal() {
    if (process.stdout.isTTY) console.clear();
}

function elapsedClock(startedAt) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function withStatus(label, operation) {
    if (!process.stdout.isTTY) {
        console.log(`${label}...`);
        return operation();
    }
    const startedAt = Date.now();
    const render = () => process.stdout.write(`\r\x1b[K${paint(label, 36)} | ${paint(`elapsed ${elapsedClock(startedAt)}`, 2)}`);
    render();
    const timer = setInterval(render, 1000);
    try { return await operation(); }
    finally { clearInterval(timer); process.stdout.write('\r\x1b[K'); }
}

const MAX_RETRIES = 3;

function isRetryableError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    const permanent = [
        'could not read track metadata',
        'not a spotify',
        'no ffmpeg found',
        'eacces',
        'eperm',
        'permission denied',
        'could not run yt-dlp',
        'downloaded yt-dlp could not be run',
        'failed to write id3 tags',
    ];
    if (permanent.some(text => message.includes(text))) return false;
    return [
        'timeout', 'timed out', 'econnreset', 'eai_again', 'enotfound',
        'socket hang up', 'network', '429', '500', '502', '503', '504',
        'no youtube results', 'yt-dlp exited with code', 'http 5',
    ].some(text => message.includes(text));
}

async function withRetries(operation, label) {
    for (let retry = 0; ; retry++) {
        try {
            return await operation();
        } catch (err) {
            if (!isRetryableError(err) || retry >= MAX_RETRIES) throw err;
            const waitMs = Math.min(1000 * 2 ** retry, 8000);
            await withStatus(`Retrying ${label}`, () => new Promise(resolve => setTimeout(resolve, waitMs)));
        }
    }
}

function printHelp() {
    console.log(`
FEX spotify-saver — persistent Spotify-to-MP3 downloader

Usage:
  node index.js [--out <folder>]
  node index.js settings [path]

Starts a long-running session:
  1. Checks/installs yt-dlp and ffmpeg once.
  2. Waits for links, one per line — paste a track or playlist link and
     press Enter. It downloads, then waits for the next one.
  3. Paste several links in a row (or pipe a file in) and they queue up,
     downloading one after another in order.
  4. Type 'exit' (or Ctrl+C, or just close the window) to stop.

Default save folder: ~/Music
Selected/configured paths are used directly.
Persistent setting: config.json next to index.js
Playlists, artists, and albums get their own subfolder named after the collection.

Track, playlist, artist, and album links use Spotify's public pages and need
no API key or login. Album artwork is embedded into each MP3 when available.
`);
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const helpRequested = args.includes('-h') || args.includes('--help');
    const settingsRequested = args[0] === 'settings';
    const outIdx = args.findIndex(a => a === '--out' || a === '-o');
    const outDir = outIdx !== -1 ? args[outIdx + 1] : null;
    const settingsPath = settingsRequested && args.length > 1 ? args.slice(1).join(' ') : null;
    return { helpRequested, outDir, settingsRequested, settingsPath };
}

function printSettings() {
    const current = config.getOutputPath();
    console.log(`Current save folder: ${current}`);
    console.log(`Config file: ${config.CONFIG_PATH}`);
    console.log('Usage: settings <folder>  (Windows examples: settings "D:\\Music" or settings "%OneDrive%\\Music")');
}

// Downloads + tags a single track into destFolder. All tracks use
// "Artist - Title.mp3", including tracks from collections.
async function downloadSingleTrack(ytdlpPath, ffmpegPath, meta, destFolder) {
    const titlePart = sanitizeFilename(meta.title);
    const artistPart = meta.artist && String(meta.artist).trim()
        ? sanitizeFilename(meta.artist)
        : '';
    const namePart = artistPart ? `${artistPart} - ${titlePart}` : titlePart;
    const filenameBase = namePart;

    const outputPathNoExt = path.join(destFolder, filenameBase);
    const finalPath = `${outputPathNoExt}.mp3`;

    if (fs.existsSync(finalPath)) {
        return finalPath;
    }

    const match = await withRetries(
        () => youtube.findBestMatch(ytdlpPath, meta.title, meta.artist, meta.durationMs),
        'YouTube search'
    );
    await withRetries(
        () => youtube.downloadAudio(ytdlpPath, ffmpegPath, match.webpage_url || match.url, outputPathNoExt, meta.title),
        'Audio download'
    );

    await tagFile(finalPath, meta);

    console.log(`${paint('Saved:', 32)} ${filenameBase}.mp3`);
    return finalPath;
}

async function downloadCollection(resolved, ytdlpPath, ffmpegPath, baseDir) {
    let collection;
    try {
        collection = await withStatus('Looking up Spotify collection', () => withRetries(() => {
            if (resolved.type === 'artist') return spotify.getArtist(resolved.id);
            if (resolved.type === 'album') return spotify.getAlbum(resolved.id);
            return spotify.getPlaylist(resolved.id);
        }, 'Spotify collection lookup'));
    } catch (err) {
        console.error(paint('❌ Could not resolve playlist:', 31, process.stderr), err.message, '\n');
        return;
    }

    if (!collection.tracks.length) {
        console.error(paint(`❌ No tracks came back for this ${resolved.type}. Spotify may not have exposed its public track list.`, 31, process.stderr));
        console.error('   Try opening the page publicly, or paste individual track links instead.\n');
        return;
    }

    const collectionFolder = ensureDir(path.join(baseDir, sanitizeFilename(collection.name)));
    const collectionLabel = resolved.type[0].toUpperCase() + resolved.type.slice(1);
    console.log(`\n${paint(`📀 ${collectionLabel}:`, 36)} ${collection.name} — ${collection.tracks.length} tracks`);
    const total = collection.tracks.length;
    const failures = [];
    for (let i = 0; i < total; i++) {
        const meta = collection.tracks[i];
        try {
            await downloadSingleTrack(ytdlpPath, ffmpegPath, meta, collectionFolder);
        } catch (err) {
            console.error(paint(`   ❌ failed: ${err.message}`, 31, process.stderr));
            failures.push(`${meta.artist} - ${meta.title}`);
        }
    }

    if (failures.length) {
        console.error(paint(`❌ Failed tracks:\n   - ${failures.join('\n   - ')}`, 31, process.stderr));
    }
    console.log(`\n🎉 Done. ${total - failures.length}/${total} tracks saved to "${collection.name}".`);
}

async function downloadTrack(link, ytdlpPath, ffmpegPath, baseDir) {
    let meta;
    try {
        meta = await withStatus('Looking up Spotify track', () => withRetries(() => spotify.getTrackMetadata(link), 'Spotify track lookup'));
    } catch (err) {
        console.error(paint('❌ Could not resolve track metadata:', 31, process.stderr), err.message, '\n');
        return;
    }

    try {
        await downloadSingleTrack(ytdlpPath, ffmpegPath, meta, baseDir);
    } catch (err) {
        console.error(paint('❌ Download failed:', 31, process.stderr), err.message, '\n');
        return;
    }
}

// One link in, fully handled, errors logged and swallowed here — a bad
// or unreachable link must never bring down the session, since this
// keeps running for whatever comes next.
async function processLink(link, ytdlpPath, ffmpegPath, baseDir) {
    const resolved = spotify.resolveLink(link);
    if (!resolved) {
        console.error(paint(`❌ Not a Spotify track, playlist, artist, or album link, skipping: ${link}`, 31, process.stderr));
        return;
    }
    if (resolved.type === 'playlist' || resolved.type === 'artist' || resolved.type === 'album') {
        await downloadCollection(resolved, ytdlpPath, ffmpegPath, baseDir);
    } else {
        await downloadTrack(link, ytdlpPath, ffmpegPath, baseDir);
    }
}

async function main() {
    const { helpRequested, outDir, settingsRequested, settingsPath } = parseArgs(process.argv);
    clearTerminal();

    if (helpRequested) {
        printHelp();
        return;
    }

    if (settingsRequested) {
        if (!settingsPath) {
            printSettings();
            return;
        }
        const savedPath = config.setOutputPath(settingsPath);
        console.log(`Save folder updated: ${savedPath}`);
        console.log('This path will be used on the next run unless --out is supplied.');
        return;
    }

    const { ytdlpPath, ffmpegPath } = await withStatus('Checking yt-dlp and FFmpeg', async () => ({
        ytdlpPath: await env.resolveYtDlp(),
        ffmpegPath: env.resolveFfmpeg(),
    }));

    let baseDir = config.getOutputPath(outDir);
    ensureDir(baseDir);

    console.log(`${paint('Ready', 32)} — saving to ${baseDir}. Paste a Spotify link, or type 'exit' to stop.`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

    // Links can arrive faster than they download (pasted in bulk, or
    // piped in from a file) — queue them and work through one at a time,
    // same reasoning as playlist tracks: keeps yt-dlp/YouTube from
    // getting hit with parallel requests and flagging them.
    const queue = [];
    let draining = false;

    async function drainQueue() {
        if (draining) return;
        draining = true;
        while (queue.length) {
            const link = queue.shift();
            await processLink(link, ytdlpPath, ffmpegPath, baseDir);
        }
        draining = false;
        rl.prompt();
    }

    rl.prompt();
    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) { rl.prompt(); return; }
        if (/^(exit|quit)$/i.test(trimmed)) { rl.close(); return; }
        const settingsMatch = trimmed.match(/^settings(?:\s+(.+))?$/i);
        if (settingsMatch) {
            if (!settingsMatch[1]) {
                printSettings();
            } else if (outDir) {
                console.log('The --out command-line override is active for this session; restart without --out to change the saved setting.');
            } else {
                baseDir = config.setOutputPath(settingsMatch[1]);
                ensureDir(baseDir);
                console.log(`Save folder updated: ${baseDir}`);
            }
            rl.prompt();
            return;
        }
        queue.push(trimmed);
        drainQueue();
    });

    rl.on('close', () => {
        console.log('\n👋 Stopped.');
        process.exit(0);
    });
}

process.on('SIGINT', () => {
    console.log('\n👋 Stopped.');
    process.exit(0);
});

async function initialize() {
    await ensureNpmDeps();
    await ensurePlatformTools();
    // Load app modules only after their npm dependencies have been verified.
    require('dotenv').config({ path: path.join(ROOT, '.env') });
    spotify = require('./lib/spotifyApi');
    youtube = require('./lib/youtube');
    env = require('./lib/environment');
    config = require('./lib/config');
    ({ tagFile } = require('./lib/tagger'));
    ({ sanitizeFilename, ensureDir, formatDuration } = require('./lib/utils'));
    await main();
}

initialize().catch(err => {
    console.error(paint('❌ Unexpected error:', 31, process.stderr), err.message);
    process.exit(1);
});
