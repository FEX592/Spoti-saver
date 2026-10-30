'use strict';
const axios = require('axios');
const { decodeHtmlEntities } = require('./utils');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
};
const TIMEOUT = 10000;

function resolveLink(link) {
    if (!link) return null;
    const trackMatch = link.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/);
    if (trackMatch) return { type: 'track', id: trackMatch[1] };
    const playlistMatch = link.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([a-zA-Z0-9]+)/);
    if (playlistMatch) return { type: 'playlist', id: playlistMatch[1] };
    const artistMatch = link.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?artist\/([a-zA-Z0-9]+)/);
    if (artistMatch) return { type: 'artist', id: artistMatch[1] };
    const albumMatch = link.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?album\/([a-zA-Z0-9]+)/);
    if (albumMatch) return { type: 'album', id: albumMatch[1] };
    return null;
}

// Recursively searches Spotify's embedded page JSON for the first object
// that looks like a track entity — a name, an artists[] array whose
// entries have their own name. Scraping an unofficial (from our side)
// page structure means the *exact* nesting can shift whenever Spotify
// changes their frontend build — matching on shape rather than a
// hardcoded path means this keeps working as long as the track object
// itself still looks like a track, even if Spotify renames or moves
// whatever wraps it. (Ported from the WhatsApp bot's .spotify command,
// confirmed still working in production.)
function findTrackEntity(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 14) return null;
    if (
        typeof node.name === 'string' &&
        Array.isArray(node.artists) &&
        node.artists.length > 0 &&
        typeof node.artists[0]?.name === 'string'
    ) {
        return node;
    }
    for (const key of Object.keys(node)) {
        const found = findTrackEntity(node[key], depth + 1);
        if (found) return found;
    }
    return null;
}

function collectTrackEntities(node, tracks = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 20) return tracks;
    if (
        (node.type === 'track' || node.duration_ms) &&
        typeof node.name === 'string' &&
        Array.isArray(node.artists) &&
        node.artists.length > 0 &&
        typeof node.artists[0]?.name === 'string'
    ) {
        tracks.push(node);
    }
    for (const key of Object.keys(node)) collectTrackEntities(node[key], tracks, depth + 1);
    return tracks;
}

function decodeEmbedString(value) {
    try { return JSON.parse(`"${value}"`); } catch (_) { return value; }
}

// Primary metadata source: fetch the track's own public page and pull
// structured data out of it — no API, no key, nothing but a normal page
// load the same way a browser would do it. Two tiers:
//   1. The page's embedded Next.js state (__NEXT_DATA__), where the
//      richest data lives — real duration_ms, full artist list, album.
//   2. Open Graph tags, which exist specifically for external consumption
//      (link previews) and are a more stable target — the tradeoff is no
//      duration in them.
async function scrapeTrackPage(link) {
    const res = await axios.get(link, { timeout: TIMEOUT, headers: HEADERS });
    const html = res.data;

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
        try {
            const json = JSON.parse(nextDataMatch[1]);
            const track = findTrackEntity(json);
            if (track) {
                return {
                    title: track.name,
                    artist: track.artists.map(a => a.name).filter(Boolean).join(', '),
                    album: track.album?.name || '',
                    durationMs: track.duration_ms || null,
                    releaseDate: track.album?.release_date || '',
                    image: track.album?.images?.[0]?.url || track.images?.[0]?.url || null,
                };
            }
        } catch (_) {
            // Falls through to OG tags below.
        }
    }

    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    const ogDesc  = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1];
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    if (ogTitle) {
        const artist = ogDesc ? ogDesc.split(/[·|]/)[0].trim() : '';
        return {
            title: decodeHtmlEntities(ogTitle),
            artist: artist ? decodeHtmlEntities(artist) : '',
            album: '',
            durationMs: null,
            releaseDate: '',
            image: ogImage || null,
        };
    }

    return null;
}

// Fallback tier: Spotify's own official, public, no-auth oEmbed endpoint.
// Title is reliable; artist/duration are not included.
async function fetchOEmbedMetadata(link) {
    try {
        const res = await axios.get('https://open.spotify.com/oembed', {
            timeout: TIMEOUT, headers: HEADERS, params: { url: link },
        });
        if (res.data?.title) {
            return {
                title: res.data.title,
                artist: '',
                album: '',
                durationMs: null,
                releaseDate: '',
                image: res.data.thumbnail_url || null,
            };
        }
    } catch (_) { /* fall through to null */ }
    return null;
}

// Track metadata, no API key or login required — page scrape first
// (richest data), oEmbed as a fallback if the page scrape comes up empty.
async function getTrackMetadata(link) {
    let meta = null;
    try {
        meta = await scrapeTrackPage(link);
    } catch (_) {
        // fall through to oEmbed
    }
    if (!meta?.title) meta = await fetchOEmbedMetadata(link);
    if (!meta?.title) {
        throw new Error('Could not read track metadata from Spotify (page structure may have changed)');
    }
    return {
        id: resolveLink(link)?.id || null,
        title: meta.title,
        artist: meta.artist || '',
        album: meta.album || '',
        durationMs: meta.durationMs || null,
        trackNumber: 1,
        image: meta.image || null,
        releaseDate: meta.releaseDate || '',
    };
}

// Public collection reader. It uses the same Spotify web pages as track
// lookups, then resolves exposed track links through getTrackMetadata.
async function scrapeCollectionPage(type, id) {
    const link = `https://open.spotify.com/${type}/${id}`;
    const res = await axios.get(link, { timeout: TIMEOUT, headers: HEADERS });
    const html = res.data;
    let name = decodeHtmlEntities(
        html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || `Spotify ${type}`
    );
    const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || null;
    let embedded = null;
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
        try { embedded = JSON.parse(nextDataMatch[1]); } catch (_) { /* use links below */ }
    }

    const tracks = [];
    const seen = new Set();
    for (const t of collectTrackEntities(embedded)) {
        const key = t.id || `${t.name}|${t.artists[0].name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
            id: t.id || null,
            title: t.name,
            artist: t.artists.map(a => a.name).filter(Boolean).join(', '),
            album: t.album?.name || name,
            durationMs: t.duration_ms || null,
            trackNumber: tracks.length + 1,
            image: t.album?.images?.[0]?.url || t.images?.[0]?.url || image,
        });
    }

    if (!tracks.length) {
        let collectionHtml = html;
        const embedTrackMeta = new Map();
        let ids = [...collectionHtml.matchAll(/(?:https?:\/\/open\.spotify\.com)?\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/g)]
            .map(match => match[1]);
        if (!ids.length) {
            try {
                const embed = await axios.get(`https://open.spotify.com/embed/${type}/${id}`, {
                    timeout: TIMEOUT, headers: HEADERS,
                });
                collectionHtml = embed.data;
                const embedName = collectionHtml.match(/"name":"([^"]+)"/)?.[1];
                if (embedName) name = decodeEmbedString(embedName);
                const trackObjects = /"uri":"spotify:track:([a-zA-Z0-9]+)"[^}]*?"title":"([^"]*)"[^}]*?"subtitle":"([^"]*)"/g;
                for (const match of collectionHtml.matchAll(trackObjects)) {
                    embedTrackMeta.set(match[1], {
                        title: decodeEmbedString(match[2]),
                        artist: decodeEmbedString(match[3]),
                    });
                }
                ids = [...collectionHtml.matchAll(/spotify:track:([a-zA-Z0-9]+)/g)].map(match => match[1]);
            } catch (_) { /* keep the normal-page result */ }
        }
        ids = [...new Set(ids)];
        for (const trackId of ids) {
            if (seen.has(trackId)) continue;
            try {
                const meta = await getTrackMetadata(`https://open.spotify.com/track/${trackId}`);
                const embedMeta = embedTrackMeta.get(trackId);
                seen.add(trackId);
                tracks.push({
                    ...meta,
                    title: meta.title || embedMeta?.title || 'Unknown title',
                    artist: meta.artist || embedMeta?.artist || '',
                    album: meta.album || name,
                    trackNumber: tracks.length + 1,
                    image: meta.image || image,
                });
            } catch (_) { /* Skip unavailable or removed tracks. */ }
        }
    }

    return { name, image, tracks };
}

async function getPlaylist(id) { return scrapeCollectionPage('playlist', id); }
async function getArtist(id) { return scrapeCollectionPage('artist', id); }
async function getAlbum(id) { return scrapeCollectionPage('album', id); }

module.exports = { resolveLink, getTrackMetadata, getPlaylist, getArtist, getAlbum };
