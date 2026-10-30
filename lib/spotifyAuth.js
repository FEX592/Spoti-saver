'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative';
const TOKEN_CACHE_PATH = path.join(__dirname, '..', '.spotify-auth.json');
const TIMEOUT = 10000;

function isTermux() {
    return process.platform === 'android'
        || !!process.env.TERMUX_VERSION
        || /com\.termux/.test(process.env.PREFIX || '');
}

// Best-effort only. Headless boxes and most Termux installs have no GUI
// opener at all (no xdg-open, no browser) — that's fine as long as the
// caller also prints the URL so the person can open it by hand.
function openBrowser(url) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"`
        : isTermux() ? `termux-open-url "${url}"`
        : `xdg-open "${url}"`;
    try {
        execSync(cmd, { stdio: 'ignore' });
    } catch (_) {
        // No GUI opener available — the printed URL below still works.
    }
}

function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
    } catch (_) {
        return null;
    }
}

function saveCache(data) {
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(data, null, 2));
}

function basicAuthHeader(clientId, clientSecret) {
    return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function exchangeCode(code, clientId, clientSecret) {
    const res = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }).toString(),
        {
            headers: {
                Authorization: `Basic ${basicAuthHeader(clientId, clientSecret)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: TIMEOUT,
        }
    );
    return res.data;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
    const res = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
        {
            headers: {
                Authorization: `Basic ${basicAuthHeader(clientId, clientSecret)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: TIMEOUT,
        }
    );
    return res.data;
}

// One-time browser login: opens the Spotify authorize page, catches the
// redirect on a local server (matching REDIRECT_URI, which must be added
// to the app's Redirect URIs in the Spotify dashboard), exchanges the
// code, and caches the refresh token so this never has to run again on
// this machine unless the token gets revoked.
function loginFlow(clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        const state = crypto.randomBytes(16).toString('hex');
        const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: REDIRECT_URI,
            scope: SCOPES,
            state,
        }).toString();

        const server = http.createServer(async (req, res) => {
            let url;
            try {
                url = new URL(req.url, REDIRECT_URI);
            } catch (_) {
                res.writeHead(400); res.end(); return;
            }
            if (url.pathname !== '/callback') {
                res.writeHead(404); res.end(); return;
            }

            const returnedState = url.searchParams.get('state');
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error || returnedState !== state || !code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<h2>Login failed — you can close this tab and check the terminal.</h2>');
                server.close();
                reject(new Error(error || 'Spotify login state mismatch or missing code'));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h2>Logged in — you can close this tab.</h2>');
            server.close();

            try {
                const tokenData = await exchangeCode(code, clientId, clientSecret);
                saveCache({
                    refresh_token: tokenData.refresh_token,
                    access_token: tokenData.access_token,
                    expires_at: Date.now() + tokenData.expires_in * 1000,
                });
                resolve(tokenData.access_token);
            } catch (err) {
                reject(err);
            }
        });

        server.on('error', reject);
        server.listen(8888, () => {
            // Printed unconditionally — on Termux/headless Linux there's
            // often no GUI opener at all, so this is the only way in.
            console.log('\nOpen this URL to log in with Spotify:');
            console.log(authUrl + '\n');
            openBrowser(authUrl);
        });
    });
}

// Returns a valid access token for the user's own account. Reuses a
// cached one if it's not expired, refreshes it via the cached refresh
// token if it is, and only falls back to a full browser login if there's
// no usable cache at all.
async function getUserToken(clientId, clientSecret) {
    const cache = loadCache();

    if (cache?.access_token && cache.expires_at > Date.now() + 5000) {
        return cache.access_token;
    }

    if (cache?.refresh_token) {
        try {
            const data = await refreshAccessToken(cache.refresh_token, clientId, clientSecret);
            saveCache({
                refresh_token: data.refresh_token || cache.refresh_token,
                access_token: data.access_token,
                expires_at: Date.now() + data.expires_in * 1000,
            });
            return data.access_token;
        } catch (_) {
            // Cached refresh token is dead (revoked/expired) — fall through
            // to a fresh login instead of failing outright.
        }
    }

    return loginFlow(clientId, clientSecret);
}

module.exports = { getUserToken, REDIRECT_URI, SCOPES };
