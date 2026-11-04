# FEX spotify-saver

Persistent CLI service that downloads Spotify tracks (and your own
playlists) as MP3s with correct embedded metadata — real title, real
artist, real cover art — so you never end up with an unlabeled file you
have to listen to just to identify it.

## Quick start — copy and paste

### Linux, macOS, WSL, or Termux

Run the installer menu from the extracted project folder:

```bash
cd /path/to/spoti-saver
chmod +x start.sh
./start.sh
spoti-saver
```

To start the installer directly from a terminal without cloning the
repository, run:
```bash
curl -fsSL https://raw.githubusercontent.com/FEX592/spoti-saver/main/start.sh | bash
```
Choose **1) Install** in the menu to install Spoti-Saver and its `spoti-saver`
startup command. The menu also offers Uninstall, Repair, and Update.

The menu reads from the terminal even though the script itself comes through a
curl pipe. After installation, `spoti-saver` works from any directory. The
managed launcher can also be removed from the menu or with:

```bash
cd /path/to/spoti-saver
./start.sh --uninstall
```

For macOS/Linux/WSL/Termux, `--install` creates one managed launcher in the
appropriate executable directory and does not create duplicates. It points to
this project's absolute `start.sh`, so the project can remain where it is.

### Windows PowerShell

Install Git for Windows or enable WSL first, then run PowerShell from the
project folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
spoti-saver
```

To remove the Windows command:

```powershell
.\install.ps1 -Uninstall
```

The Windows installer creates one managed `%USERPROFILE%\bin\spoti-saver.cmd`
launcher that invokes this project's `start.sh`.

## Running it

```bash
node index.js
```

The project also includes a lightweight cross-platform launcher:

```bash
./start.sh
```

The installer supports Termux, Linux/WSL (`apt`, `dnf`, `yum`, `pacman`, and
`apk`), and macOS (Homebrew); the Windows PowerShell installer is described
above. Install, Repair, and Update check Node.js/npm, install application
dependencies and run the platform bootstrap. Updates replace app files without
deleting the saved configuration or downloaded files outside the app folder.

On first setup, a platform bootstrap wizard appears before the downloader.
It supports Windows, Termux/Android, Linux, WSL, and macOS. The selected
platform and Linux distribution are saved in `config.json`; later launches
reuse that target. When a saved target is found, the program asks whether to
re-run setup or launch normally without reinstalling anything.
Normal launch still verifies the required tools; if `yt-dlp`, `ffmpeg`, or
`ffprobe` is missing, setup starts automatically instead of allowing a
download to fail.
Linux and WSL installations can select Debian/Ubuntu, Fedora/RHEL, Arch,
openSUSE, or Alpine. The wizard uses the native package manager for the
selected environment, force-reinstalls the native tools and Node dependencies,
prints their resolved paths, and verifies every dependency before the
downloader starts.

You can also run the installer directly:

```bash
node bootstrap.js
```

For scripts or headless sessions, use automatic detection:

```bash
node bootstrap.js --auto
```

To change the saved target later, run:

```bash
node bootstrap.js --reselect-platform
```

That starts a long-running session — it doesn't take the link as an
argument. On start it automatically:

1. Installs its own npm dependencies (`axios`, `node-id3`, `ffmpeg-static`,
   `dotenv`) if `node_modules` isn't there yet.
2. Runs `bootstrap.js` for the selected platform on every normal startup.
3. If the target is saved, asks whether to re-run setup or launch normally.
4. When setup is selected, reinstalls and verifies the selected platform's native tools and all Node dependencies.
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

The auto-download of standalone Linux binaries is not used on Termux because
Termux uses bionic libc rather than glibc. The bootstrap installs the native
Termux packages instead.

The `bin/yt-dlp.exe` file included in Windows copies of this project is not
usable in Termux. Termux uses the native executables installed by `pkg`.
The launcher automatically prepends `$PREFIX/bin` to `PATH`, checks for
`yt-dlp`, `ffmpeg`, and `ffprobe`, and installs any missing packages with
`pkg` on first launch. It also passes the native FFmpeg directory to yt-dlp,
so both FFmpeg and FFprobe are discoverable without manual `export` commands.
It sets `YTDLP_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH` inside the Node
process itself; a child script cannot export variables into the parent shell.

The program uses `npm install --ignore-scripts` on Termux so the unsupported
`ffmpeg-static` installer is not executed. The native Termux `ffmpeg` package
is used instead. Do not run a separate plain `npm install`; start the program
or run `node bootstrap.js` so the complete setup and path verification run.

Normal Linux x64 and arm64 systems can use the automatic standalone yt-dlp
download, but installing `yt-dlp` and `ffmpeg` from the system package
manager is also supported. Windows uses `yt-dlp.exe` and resolves configured
OneDrive paths normally.

Only set `YTDLP_PATH`, `FFMPEG_PATH`, or `FFPROBE_PATH` if the tools are in a
nonstandard location outside `$PREFIX/bin`.

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
