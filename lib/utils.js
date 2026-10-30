'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Strips characters that are illegal in Windows/macOS/Linux filenames and
// collapses whitespace. Applied to track titles, artist names, and playlist
// names before they ever touch the filesystem.
function sanitizeFilename(name) {
    return String(name || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150) || 'untitled';
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

// Resolves the *real* Desktop path — critical on Windows machines where
// OneDrive's "Known Folder Move" redirects Desktop to
// C:\Users\<user>\OneDrive\Desktop. os.homedir() + 'Desktop' has no idea
// that happened and silently writes to a plain folder that isn't the one
// shown in File Explorer. Asking PowerShell for it goes through the same
// Shell API Explorer itself uses, so it always matches what's on screen.
// macOS/Linux don't have this problem, so they skip straight to the
// plain join.
function resolveDesktopPath() {
    if (process.platform === 'win32') {
        try {
            const out = execSync(
                'powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Desktop\')"',
                { encoding: 'utf8', timeout: 5000 }
            ).trim();
            if (out) return out;
        } catch (_) {
            // Falls through to the plain join below.
        }
    }
    return path.join(os.homedir(), 'Desktop');
}

// Use the user's Music folder as the default drop point. A configured or selected
// output path is used directly without adding another parent folder.
function defaultBaseDir() {
    return path.join(os.homedir(), 'Music');
}

// "01", "02" ... "12" — width scales with playlist size so a 150-track
// playlist gets "001" instead of overflowing 2-digit padding.
function padTrackNumber(n, total) {
    const width = Math.max(2, String(total).length);
    return String(n).padStart(width, '0');
}

function formatDuration(ms) {
    if (!ms) return '';
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function decodeHtmlEntities(str) {
    return String(str || '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

module.exports = {
    sanitizeFilename, ensureDir, defaultBaseDir, padTrackNumber,
    formatDuration, decodeHtmlEntities,
};
