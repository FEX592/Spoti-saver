'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_TIMEOUT = 10000;
const DOWNLOAD_TIMEOUT = 120000;
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
};

function pick(obj, paths = [
    'downloadURL', 'download_url', 'downloadUrl', 'url', 'download',
    'result.downloadURL', 'result.download_url', 'result.url', 'result.download',
    'data.downloadURL', 'data.download_url', 'data.url', 'data.download',
]) {
    for (const pathName of paths) {
        const value = pathName.split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
        if (value) return value;
    }
    return null;
}

function videoIdFromUrl(url) {
    return String(url || '').match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([a-zA-Z0-9_-]{11})/)?.[1] || null;
}

function isValidAudio(buffer) {
    if (!buffer || buffer.length < 5000) return false;
    const head = buffer.slice(0, 10).toString('hex');
    if (head.startsWith('494433') || head.startsWith('664c6143') || head.startsWith('4f676753')) return true;
    if (['fffb', 'fff3'].includes(buffer.slice(0, 2).toString('hex'))) return true;
    const sample = buffer.slice(0, 200).toString('utf8').toLowerCase();
    return !sample.includes('<html') && !sample.includes('<!doctype') && buffer.length > 50000;
}

async function requestApi(url, params) {
    const response = await axios.get(url, { params, timeout: API_TIMEOUT, headers: HEADERS });
    return response.data;
}

async function apiDownload(url, endpoint, parser, extraParams = {}) {
    console.log(`   ⏳ Requesting audio conversion service: ${new URL(endpoint).hostname}`);
    const data = await requestApi(endpoint, { url, ...extraParams });
    const download = parser(data);
    if (!download) throw new Error('No download URL returned');
    console.log('   ⬇️  Download service responded; receiving the media file...');
    let lastProgressAt = 0;
    const response = await axios.get(download, {
        responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT, headers: HEADERS,
        onDownloadProgress: event => {
            const now = Date.now();
            if (now - lastProgressAt < 2000) return;
            lastProgressAt = now;
            const received = `${(event.loaded / 1048576).toFixed(1)} MB`;
            const percent = event.total ? Math.round((event.progress ?? event.loaded / event.total) * 100) : null;
            const total = event.total ? ` / ${(event.total / 1048576).toFixed(1)} MB (${percent}%)` : '';
            console.log(`   ⬇️  Download progress: ${received}${total}`);
        },
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length < 5000) throw new Error('Downloaded file too small');
    console.log(`   ✅ Media received (${(buffer.length / 1048576).toFixed(1)} MB).`);
    return { buffer, title: data?.title || data?.data?.title };
}

function prexzyParser(data, extra = []) {
    return pick(data, [...extra,
        'downloadURL', 'download_url', 'downloadUrl', 'url', 'download',
        'result.downloadURL', 'result.download_url', 'result.url', 'result.download',
        'data.downloadURL', 'data.download_url', 'data.url', 'data.download',
    ]);
}

async function downloadAudioViaApis(videoUrl) {
    const attempts = [
        () => apiDownload(videoUrl, 'https://eliteprotech-apis.zone.id/ytdown', data =>
            data?.success && data?.downloadURL ? data.downloadURL : null, { format: 'mp3' }),
        () => apiDownload(videoUrl, 'https://prexzyapis.com/download/aio', data =>
            prexzyParser(data, ['data.audio', 'audio', 'result.audio'])),
        () => apiDownload(videoUrl, 'https://prexzyapis.com/download/ytmp3', data => prexzyParser(data)),
        () => apiDownload(videoUrl, 'https://api.yupra.my.id/api/downloader/ytmp3', data =>
            data?.success ? data?.data?.download_url : null),
        () => apiDownload(videoUrl, 'https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3', data => data?.dl),
        () => downloadFromInvidious(videoUrl),
    ];

    for (let i = 0; i < attempts.length; i++) {
        try {
            console.log(`   ⏳ Audio source attempt ${i + 1}/${attempts.length}...`);
            const result = await attempts[i]();
            if (isValidAudio(result.buffer)) return result;
            console.warn(`   ⚠️ Audio source attempt ${i + 1} returned an invalid media file; trying the next source.`);
        } catch (error) {
            console.warn(`   ⚠️ Audio source attempt ${i + 1} failed: ${error.message}; trying the next source.`);
        }
    }
    throw new Error('All YouTube audio API fallbacks failed');
}

async function downloadFromInvidious(videoUrl) {
    const id = videoIdFromUrl(videoUrl);
    if (!id) throw new Error('Could not extract video ID');
    const instances = ['https://yewtu.be', 'https://invidious.nerdvpn.de', 'https://inv.nadeko.net'];
    for (const instance of instances) {
        try {
            console.log(`   ⏳ Trying alternate audio source: ${new URL(instance).hostname}`);
            const response = await axios.get(`${instance}/api/v1/videos/${id}`, { timeout: API_TIMEOUT, headers: HEADERS });
            const audio = (response.data?.adaptiveFormats || [])
                .filter(format => format.type?.includes('audio'))
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            if (audio?.url) {
                const file = await axios.get(audio.url, {
                    responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT, headers: HEADERS,
                });
                return { buffer: Buffer.from(file.data), title: response.data.title };
            }
        } catch (_) {
            console.warn(`   ⚠️ Alternate audio source ${new URL(instance).hostname} failed; trying another.`);
        }
    }
    throw new Error('Invidious returned no audio stream');
}

async function downloadVideoViaApis(videoUrl) {
    const attempts = [
        () => apiDownload(videoUrl, 'https://eliteprotech-apis.zone.id/ytdown', data =>
            data?.success && data?.downloadURL ? data.downloadURL : null, { format: 'mp4' }),
        () => apiDownload(videoUrl, 'https://prexzyapis.com/download/aio', data =>
            prexzyParser(data, ['data.video', 'video', 'result.video'])),
        () => apiDownload(videoUrl, 'https://prexzyapis.com/download/ytmp4', data => prexzyParser(data)),
        () => apiDownload(videoUrl, 'https://api.yupra.my.id/api/downloader/ytmp4', data =>
            data?.success ? data?.data?.download_url : null),
        () => apiDownload(videoUrl, 'https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4', data => data?.dl),
    ];

    for (let i = 0; i < attempts.length; i++) {
        try {
            console.log(`   ⏳ Video conversion attempt ${i + 1}/${attempts.length}...`);
            const result = await attempts[i]();
            if (result.buffer.length >= 10000) return result;
            console.warn(`   ⚠️ Video conversion attempt ${i + 1} returned an invalid media file; trying the next source.`);
        } catch (error) {
            console.warn(`   ⚠️ Video conversion attempt ${i + 1} failed: ${error.message}; trying the next source.`);
        }
    }
    throw new Error('All YouTube video API fallbacks failed');
}

function runYtDlpCapture(ytdlpPath, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ytdlpPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', data => { stdout += data; });
        proc.stderr.on('data', data => { stderr += data; });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0 && !stdout.trim()) return reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
            resolve(stdout);
        });
    });
}

// Forwards a child process's output line-by-line, dropping yt-dlp's noisy
// [youtube] metadata while preserving [download] progress and any other
// useful output (ffmpeg postprocessing steps, ERROR: lines, etc). Buffers partial
// lines across chunk boundaries — yt-dlp's progress lines use bare \r,
// not \n, so a naive per-chunk split would cut lines in half.
function makeLineFilter(outStream) {
    let buffer = '';
    return chunk => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop();
        for (const line of lines) {
            if (!line || /^\[youtube\]/i.test(line.trim())) continue;
            outStream.write(line + '\n');
        }
    };
}

function runYtDlpInherit(ytdlpPath, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ytdlpPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', makeLineFilter(process.stdout));
        proc.stderr.on('data', makeLineFilter(process.stderr));
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp exited with code ${code}`)));
    });
}

async function findBestMatch(ytdlpPath, title, artist, targetDurationMs) {
    const artists = String(artist || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const queries = [...new Set([
        [title, artist].filter(Boolean).join(' '),
        [title, artists[0]].filter(Boolean).join(' '),
        String(title || '').trim(),
    ].filter(Boolean))];

    let candidates = [];
    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        try {
            console.log(`   ⏳ Searching YouTube (${i + 1}/${queries.length}): ${query}`);
            const stdout = await runYtDlpCapture(ytdlpPath, ['--dump-json', '--no-warnings', `ytsearch5:${query}`]);
            candidates = stdout.split('\n').map(line => line.trim()).filter(Boolean)
                .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
            if (candidates.length) break;
        } catch (error) {
            console.warn(`   ⚠️ Search attempt ${i + 1} failed: ${error.message}; trying a broader query.`);
        }
    }

    if (!candidates.length) throw new Error(`No YouTube results for "${queries[0] || title}"`);
    if (!targetDurationMs) return candidates[0];
    const targetSec = targetDurationMs / 1000;
    candidates.sort((a, b) => Math.abs((a.duration || 0) - targetSec) - Math.abs((b.duration || 0) - targetSec));
    return candidates[0];
}

function convertBufferToMp3(buffer, ffmpegPath, outputPath) {
    return new Promise((resolve, reject) => {
        const tempInput = `${outputPath}.api-input`;
        fs.writeFileSync(tempInput, buffer);
        const proc = spawn(ffmpegPath, ['-y', '-i', tempInput, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', outputPath], { stdio: 'ignore' });
        const cleanup = () => { try { fs.unlinkSync(tempInput); } catch (_) {} };
        proc.on('error', error => { cleanup(); reject(error); });
        proc.on('close', code => {
            cleanup();
            if (code === 0 && fs.existsSync(outputPath)) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
        });
    });
}

function ffmpegLocation(ffmpegPath) {
    // yt-dlp accepts either an executable or a directory. Passing the
    // directory is more reliable on Termux because ffprobe lives beside
    // ffmpeg and must be discoverable during postprocessing.
    return path.dirname(ffmpegPath);
}

async function downloadAudio(ytdlpPath, ffmpegPath, youtubeUrl, outputPathNoExt) {
    // Run the complete bot-matched API lineup first. The caller owns retries.
    try {
        const apiResult = await downloadAudioViaApis(youtubeUrl);
        await convertBufferToMp3(apiResult.buffer, ffmpegPath, `${outputPathNoExt}.mp3`);
        return `${outputPathNoExt}.mp3`;
    } catch (_) {
        console.warn('   ⚠️ Direct audio sources failed; trying video conversion services.');
        // Try the complete MP4 lineup before falling back to local yt-dlp.
        try {
            const videoResult = await downloadVideoViaApis(youtubeUrl);
            console.log('   ⏳ Converting received media to MP3 with ffmpeg...');
            await convertBufferToMp3(videoResult.buffer, ffmpegPath, `${outputPathNoExt}.mp3`);
            return `${outputPathNoExt}.mp3`;
        } catch (_) {
            console.warn('   ⚠️ Conversion services failed; using local yt-dlp. Its transfer progress is shown below.');
            await runYtDlpInherit(ytdlpPath, [
                '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '--no-playlist', '--no-warnings', '--ffmpeg-location', ffmpegLocation(ffmpegPath),
                '-o', `${outputPathNoExt}.%(ext)s`, youtubeUrl,
            ]);
        }
    }

    const expected = `${outputPathNoExt}.mp3`;
    if (fs.existsSync(expected)) return expected;
    const dir = path.dirname(outputPathNoExt);
    const base = path.basename(outputPathNoExt);
    const found = fs.readdirSync(dir).find(file => file.startsWith(base + '.'));
    if (!found) throw new Error('yt-dlp finished but no output file was found.');
    const recovered = path.join(dir, found);
    fs.renameSync(recovered, expected);
    return expected;
}

module.exports = { findBestMatch, downloadAudio };
