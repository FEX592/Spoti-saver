#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const ROOT = __dirname;

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

function ensurePlatformTools() {
    const missing = ['yt-dlp', 'ffmpeg', 'ffprobe'].filter(command => !commandAvailable(command));
    const bootstrap = path.join(ROOT, 'bootstrap.js');
    if (!fs.existsSync(bootstrap)) {
        throw new Error(`Missing tools: ${missing.join(', ')}. The project bootstrap.js file is missing.`);
    }
    console.log(`📦 Complete setup: ${missing.length ? `missing ${missing.join(', ')}` : 'tools already present; reinstalling and verifying all dependencies'}`);
    const args = [bootstrap];
    // Interactive terminals get the platform/distro selection wizard. Piped
    // or headless launches use safe OS/package-manager auto-detection instead.
    if (!process.stdin.isTTY || !process.stdout.isTTY) args.push('--auto');
    execSync(`"${process.execPath}" ${args.map(value => `"${value}"`).join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true });
}

// ── Step 1: npm deps ─────────────────────────────────────────────────────
// This has to happen with zero external requires (fs/path/child_process
// only), because spotifyApi.js/tagger.js need axios/node-id3 at their own
// top level — if we required them before this check, a fresh clone would
// crash on MODULE_NOT_FOUND before ever getting a chance to self-heal.
function ensureNpmDeps() {
    const required = ['axios', 'node-id3', 'ffmpeg-static', 'dotenv'];
    const missing = required.filter(pkg => !fs.existsSync(path.join(ROOT, 'node_modules', pkg)));
    if (missing.length) {
        // ffmpeg-static has no Termux/Android binary and its install script
        // aborts npm install. Termux uses the native pkg ffmpeg package.
        const installCommand = isTermuxRuntime() ? 'npm install --ignore-scripts' : 'npm install';
        execSync(installCommand, { cwd: ROOT, stdio: 'inherit' });
    }
}

ensureNpmDeps();
ensurePlatformTools();

// Safe now — node_modules is guaranteed to exist.
require('dotenv').config({ path: path.join(ROOT, '.env') });
const spotify = require('./lib/spotifyApi');
const youtube = require('./lib/youtube');
const env = require('./lib/environment');
const config = require('./lib/config');
const { tagFile } = require('./lib/tagger');
const {
    sanitizeFilename, ensureDir,
    formatDuration,
} = require('./lib/utils');

function clearTerminal() {
    if (process.stdout.isTTY) console.clear();
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
            console.error(`   ⚠️ ${label} failed (${err.message}); retry ${retry + 1}/${MAX_RETRIES} in ${waitMs / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
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
        console.log(`⏭  Skipping (already exists): ${filenameBase}.mp3`);
        return finalPath;
    }

    console.log(`\n🔎 ${meta.title} — ${meta.artist}${meta.durationMs ? ' (' + formatDuration(meta.durationMs) + ')' : ''}`);
    const match = await withRetries(
        () => youtube.findBestMatch(ytdlpPath, meta.title, meta.artist, meta.durationMs),
        'YouTube search'
    );
    console.log(`   ↳ matched: ${match.title || match.webpage_url}${match.duration ? ' (' + formatDuration(match.duration * 1000) + ')' : ''}`);
    console.log('   ⬇️  downloading...');
    await withRetries(
        () => youtube.downloadAudio(ytdlpPath, ffmpegPath, match.webpage_url || match.url, outputPathNoExt),
        'Audio download'
    );

    console.log('   🏷️  writing metadata...');
    await tagFile(finalPath, meta);

    console.log(`   ✅ saved: ${filenameBase}.mp3`);
    return finalPath;
}

async function downloadCollection(resolved, ytdlpPath, ffmpegPath, baseDir) {
    let collection;
    try {
        collection = await withRetries(() => {
            if (resolved.type === 'artist') return spotify.getArtist(resolved.id);
            if (resolved.type === 'album') return spotify.getAlbum(resolved.id);
            return spotify.getPlaylist(resolved.id);
        }, 'Spotify collection lookup');
    } catch (err) {
        console.error('❌ Could not resolve playlist:', err.message, '\n');
        return;
    }

    if (!collection.tracks.length) {
        console.error(`❌ No tracks came back for this ${resolved.type}. Spotify may not have exposed its public track list.`);
        console.error('   Try opening the page publicly, or paste individual track links instead.\n');
        return;
    }

    const collectionFolder = ensureDir(path.join(baseDir, sanitizeFilename(collection.name)));
    const collectionLabel = resolved.type[0].toUpperCase() + resolved.type.slice(1);
    console.log(`\n📀 ${collectionLabel}: ${collection.name} — ${collection.tracks.length} tracks`);
    console.log(`📁 Saving to: ${collectionFolder}\n`);
    const total = collection.tracks.length;
    const failures = [];
    for (let i = 0; i < total; i++) {
        const meta = collection.tracks[i];
        console.log(`[${i + 1}/${total}]`);
        try {
            await downloadSingleTrack(ytdlpPath, ffmpegPath, meta, collectionFolder);
        } catch (err) {
            console.error(`   ❌ failed: ${err.message}`);
            failures.push(`${meta.artist} - ${meta.title}`);
        }
    }

    if (failures.length) {
        console.error(`❌ Failed tracks:\n   - ${failures.join('\n   - ')}`);
    }
    console.log(`\n🎉 Done. ${total - failures.length}/${total} tracks saved to "${collection.name}".`);
}

async function downloadTrack(link, ytdlpPath, ffmpegPath, baseDir) {
    let meta;
    try {
        meta = await withRetries(() => spotify.getTrackMetadata(link), 'Spotify track lookup');
    } catch (err) {
        console.error('❌ Could not resolve track metadata:', err.message, '\n');
        return;
    }

    try {
        await downloadSingleTrack(ytdlpPath, ffmpegPath, meta, baseDir);
    } catch (err) {
        console.error('❌ Download failed:', err.message, '\n');
        return;
    }
    console.log('🎉 Done.\n');
}

// One link in, fully handled, errors logged and swallowed here — a bad
// or unreachable link must never bring down the session, since this
// keeps running for whatever comes next.
async function processLink(link, ytdlpPath, ffmpegPath, baseDir) {
    const resolved = spotify.resolveLink(link);
    if (!resolved) {
        console.error(`❌ Not a Spotify track, playlist, artist, or album link, skipping: ${link}\n`);
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

    console.log('🔧 Checking yt-dlp / ffmpeg...');
    const ytdlpPath = await env.resolveYtDlp();
    const ffmpegPath = env.resolveFfmpeg();
    console.log(`   yt-dlp: ${ytdlpPath}`);
    console.log(`   ffmpeg: ${ffmpegPath}`);
    if (process.env.FFPROBE_PATH) console.log(`   ffprobe: ${process.env.FFPROBE_PATH}`);

    let baseDir = config.getOutputPath(outDir);
    ensureDir(baseDir);

    console.log(`\n✅ Ready — saving to: ${baseDir}`);
    console.log('Paste a Spotify track or playlist link and press Enter.');
    console.log("Multiple links queue up and download one after another in order. Type 'exit' (or Ctrl+C) to stop.\n");

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
            clearTerminal();
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

main().catch(err => {
    console.error('❌ Unexpected error:', err.message);
    process.exit(1);
});
