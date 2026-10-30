# FEX spotify-saver

Persistent CLI service that downloads Spotify tracks (and your own
playlists) as MP3s with correct embedded metadata — real title, real
artist, real cover art — so you never end up with an unlabeled file you
have to listen to just to identify it.

## Running it

```bash
node index.js
```

On first launch, if `yt-dlp`, `ffmpeg`, or `ffprobe` is missing, a platform
bootstrap wizard appears. It supports Windows, Termux/Android, Linux, WSL,
and macOS. Linux and WSL installations can select Debian/Ubuntu, Fedora/RHEL,
Arch, openSUSE, or Alpine when the distribution cannot be detected. The
wizard uses the native package manager for the selected environment and
verifies all three commands before the downloader starts.

You can also run the installer directly:

```bash
node bootstrap.js
```

For scripts or headless sessions, use automatic detection:

```bash
node bootstrap.js --auto
```

That starts a long-running session — it doesn't take the link as an
argument. On start it automatically:

1. Installs its own npm dependencies (`axios`, `node-id3`, `ffmpeg-static`,
   `dotenv`) if `node_modules` isn't there yet.
2. Runs `bootstrap.js` when `yt-dlp`, `ffmpeg`, or `ffprobe` is missing.
3. Verifies the selected platform's native installation before continuing.
4. Then waits for you to paste links.

From there, paste a track or playlist link and press Enter — it
downloads, then waits for the next one. Paste several in a row (or pipe a
text file of links in) and they queue up, downloading one after another
in order. Type `exit` (or hit Ctrl+C, or just close the window) to stop.
Type `settings` to see the current save folder, or type `settings <folder>`
to change it while the program is running. The change is saved in
`config.json` and is used on later runs.

Every later run reuses whatever it already set up, so only the very first
run does any installing.

**The only hard prerequisite is Node.js itself** — everything downstream
of that is handled for you.

## Setup — tracks, playlists, artists, and albums need nothing

**Tracks work with zero setup.** No API key, no `.env`, no login —
metadata comes straight off Spotify's public track page.

Tracks, playlists, artists, and albums are read from their public Spotify pages.
No API key, `.env` file, or Spotify login is required.

## How it works

Spotify's audio is DRM-protected, so like the WhatsApp bot's `.spotify`
command this is based on, this doesn't download from Spotify directly. It:

1. Resolves real metadata (title, artist, album, cover art, duration).
   - **Tracks:** scrapes the track's own public page — first its embedded
     Next.js state (`__NEXT_DATA__`, which has real `duration_ms` and the
     full artist list), falling back to Open Graph tags, falling back to
     Spotify's public oEmbed endpoint. All three are unauthenticated —
     the same requests a browser or a link-preview bot makes.
   - **Playlists, artists, and albums:** scrape their public page and resolve the
     exposed track links through the same public track-page method.
2. Searches YouTube for the best match and picks the candidate whose
   duration is closest to the actual Spotify duration, instead of blindly
   trusting the first search result (which is sometimes a remix, extended
   cut, or reaction video).
3. Downloads the audio via `yt-dlp`, converts to MP3 via `ffmpeg`.
4. Overwrites whatever junk metadata YouTube/yt-dlp guessed with the real
   Spotify metadata, including embedded album cover art downloaded from
   Spotify's image CDN.

For each YouTube audio download, the bot-matched fallback lineup is attempted
in full before the outer retry starts again: EliteProTech MP3, Prexzy AIO,
Prexzy YTMP3, Yupra YTMP3, Okatsu YTMP3, Invidious audio, then the local
yt-dlp fallback. No endpoint-level retry interrupts this lineup.

Transient network, rate-limit, server, and temporary yt-dlp failures are
retried up to three times with increasing delays. Invalid links, missing
executables, permission failures, tagging failures, and other permanent
errors are reported immediately without wasting time on retries.

## Playlist and artist scope

Public playlist, artist, and album links are handled without Spotify API access. The
tool uses the collection page data when Spotify exposes it and otherwise
resolves track links through the same public track-page scraper used for
individual tracks. Spotify may expose only a subset of a very large or
restricted collection; unavailable, deleted, or hidden entries are skipped.

## Where files go

- Default base folder: `~/Music`
- A selected or configured output folder is used directly; no extra parent
  folder is created.
- A single track lands directly in that folder as `Artist - Title.mp3`
- A playlist, artist, or album gets its own subfolder named after the
  collection, with tracks named `Artist - Title.mp3`.

```
Music/
├── Artist - Some Standalone Track.mp3
└── Late Night Drive/
    ├── Artist - Song One.mp3
    ├── Artist - Song Two.mp3
        └── ...
```

Already-downloaded files are skipped (matched by filename), so
re-pasting the same playlist link only fetches what's missing.

Pass `--out <folder>` at startup to change the base save folder for the
whole session:

```bash
node index.js --out "D:\Music"
```

To set the folder persistently before starting a session, use:

```bash
node index.js settings "D:\Music"
```

On Windows, OneDrive paths can be entered directly or through an environment
variable. This is useful when the OneDrive folder changes between accounts:

```text
settings "%OneDrive%\Music"
settings "${OneDrive}\Music"
```

The saved `config.json` is machine-specific and is ignored by Git. A
command-line `--out` value takes priority for the current run but does not
overwrite the persistent setting.

## Linux / Termux

The auto-download in step 2/3 above only works when a standalone glibc
binary can actually run on your machine. That's true for a normal
x86_64/arm64 Linux desktop, but **not** for Termux (bionic libc, not
glibc) — there, install both up front instead of relying on auto-download:

```bash
pkg install yt-dlp ffmpeg
```

The `bin/yt-dlp.exe` file included in Windows copies of this project is not
usable in Termux. Termux uses the native executables installed by `pkg`.
The launcher automatically prepends `$PREFIX/bin` to `PATH`, checks for
`yt-dlp`, `ffmpeg`, and `ffprobe`, and installs any missing packages with
`pkg` on first launch. It also passes the native FFmpeg directory to yt-dlp,
so both FFmpeg and FFprobe are discoverable without manual `export` commands.

The program automatically uses `npm install --ignore-scripts` on Termux so
the unsupported `ffmpeg-static` installer is not executed. The native Termux
`ffmpeg` package is used instead. At startup, if `yt-dlp` or `ffmpeg` is
missing and `pkg` is available, the program installs the missing packages
automatically. If automatic package installation is unavailable, run the
command above manually. Do not run a separate plain `npm install` before
installing the Termux packages, because that will invoke the unsupported
`ffmpeg-static` installer.

Normal Linux x64 and arm64 systems can use the automatic standalone yt-dlp
download, but installing `yt-dlp` and `ffmpeg` from the system package
manager is also supported. Windows uses `yt-dlp.exe` and resolves configured
OneDrive paths normally.

Only if the tools are installed in a nonstandard location, set these optional
overrides before starting the program:

```bash
export YTDLP_PATH="$PREFIX/bin/yt-dlp"
export FFMPEG_PATH="$PREFIX/bin/ffmpeg"
node index.js
```

On any headless/SSH/Termux setup with no default browser, the Spotify
login step now always prints the login URL to the terminal — open it on
any device (e.g. your phone) and log in there; the callback still comes
back to the machine running the script.

## Notes

- Downloads (including every track in a playlist) run one at a time, not
  in parallel — this keeps yt-dlp/YouTube from rate-limiting or flagging
  the requests, at the cost of speed on large queues.
- The auto-downloaded `yt-dlp` binary lands in `./bin/` next to `index.js`
  — safe to delete if you ever want it to re-check for a system install.
- `.env` and `.spotify-auth.json` both hold secrets (API credentials and
  your login refresh token) — both are gitignored; don't commit them.
- For personal use — respect artists and Spotify's/YouTube's terms where
  they apply to how you use this.
