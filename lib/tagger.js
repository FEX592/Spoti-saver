'use strict';
const axios = require('axios');
const NodeID3 = require('node-id3');

async function fetchImageBuffer(url) {
    if (!url) return null;
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        return {
            buffer: Buffer.from(res.data),
            mime: res.headers['content-type']?.split(';')[0] || 'image/jpeg',
        };
    } catch (_) {
        return null; // missing cover art shouldn't block a correctly-tagged file
    }
}

// Overwrites whatever yt-dlp/YouTube's own metadata guessed with the real
// Spotify title/artist/album/cover — this is the whole point of the tool:
// no more opening a file to find out it's tagged "Official Audio (2024)"
// by the wrong uploader.
async function tagFile(filePath, meta) {
    const imageBuffer = await fetchImageBuffer(meta.image);

    const tags = {
        title: meta.title,
        artist: meta.artist,
        album: meta.album || meta.title,
        trackNumber: String(meta.trackNumber || 1),
    };
    if (meta.releaseDate) tags.year = meta.releaseDate.slice(0, 4);
    if (imageBuffer) {
        tags.image = {
            mime: imageBuffer.mime,
            type: { id: 3, name: 'front cover' },
            description: 'Cover',
            imageBuffer: imageBuffer.buffer,
        };
    }

    const result = NodeID3.write(tags, filePath);
    if (result !== true) {
        throw new Error('Failed to write ID3 tags: ' + (result?.message || String(result)));
    }
}

module.exports = { tagFile };
