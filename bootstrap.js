#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

if (process.env.PREFIX) {
    const termuxBin = path.join(process.env.PREFIX, 'bin');
    const pathParts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (!pathParts.includes(termuxBin)) process.env.PATH = [termuxBin, ...pathParts].join(path.delimiter);
    process.env.YTDLP_PATH = process.env.YTDLP_PATH || path.join(termuxBin, 'yt-dlp');
    process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || path.join(termuxBin, 'ffmpeg');
    process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || path.join(termuxBin, 'ffprobe');
}

function isWindows() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }
function isTermux() { return process.platform === 'android' || !!process.env.TERMUX_VERSION || /com\.termux/.test(process.env.PREFIX || ''); }
function isWsl() {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    try { return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch (_) { return false; }
}
function commandExists(command) {
    try { execFileSync(isWindows() ? 'where' : 'command', isWindows() ? [command] : ['-v', command], { stdio: 'ignore', shell: !isWindows() }); return true; }
    catch (_) { return false; }
}
function missingTools() { return ['yt-dlp', 'ffmpeg', 'ffprobe'].filter(tool => !commandExists(tool)); }
function readInstallTarget() {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return config && config.installationTarget && typeof config.installationTarget === 'object'
            ? config.installationTarget : null;
    } catch (_) { return null; }
}
function saveInstallTarget(platform, distro) {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (_) {}
    config.installationTarget = { platform, ...(distro ? { distro } : {}) };
    const tempPath = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, CONFIG_PATH);
    console.log(`\nSaved installation target in ${CONFIG_PATH}: ${platform}${distro ? ` (${distro})` : ''}`);
}
function run(command, args) {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited with code ${result.status}`);
}
function sudo(command, args) { return commandExists('sudo') ? run('sudo', [command, ...args]) : run(command, args); }
function detectLinuxFamily() {
    try {
        const text = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase();
        const id = (text.match(/^id=([^\n]+)/m) || [])[1]?.replace(/"/g, '') || '';
        const like = (text.match(/^id_like=([^\n]+)/m) || [])[1]?.replace(/"/g, '') || '';
        if (/ubuntu|debian|linuxmint|pop|kali/.test(`${id} ${like}`)) return 'debian';
        if (/fedora|rhel|centos|rocky|alma/.test(`${id} ${like}`)) return 'fedora';
        if (/arch|manjaro|endeavouros/.test(`${id} ${like}`)) return 'arch';
        if (/opensuse|suse/.test(`${id} ${like}`)) return 'suse';
        if (/alpine/.test(`${id} ${like}`)) return 'alpine';
    } catch (_) {}
    if (commandExists('apt-get')) return 'debian';
    if (commandExists('dnf') || commandExists('yum')) return 'fedora';
    if (commandExists('pacman')) return 'arch';
    if (commandExists('zypper')) return 'suse';
    if (commandExists('apk')) return 'alpine';
    return null;
}
function detectedPlatform() {
    if (isTermux()) return 'termux';
    if (isWindows()) return isWsl() ? 'wsl' : 'windows';
    if (isWsl()) return 'wsl';
    if (isMac()) return 'mac';
    if (process.platform === 'linux') return 'linux';
    return 'other';
}
function ask(question, choices) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n${question}`);
        choices.forEach((choice, i) => console.log(`  ${i + 1}) ${choice[0]}`));
        rl.question('Select a number: ', answer => { rl.close(); const n = Number(answer) - 1; resolve(choices[n]?.[1] || null); });
    });
}
async function choosePlatform() {
    const saved = readInstallTarget();
    const detected = detectedPlatform();
    const forced = process.env.SPOTI_SAVER_PLATFORM;
    if (forced) return forced;
    if (saved?.platform && !process.argv.includes('--reselect-platform')) {
        console.log(`Saved installation target: ${saved.platform}${saved.distro ? ` (${saved.distro})` : ''}`);
        return saved.platform;
    }
    if (process.argv.includes('--auto') && detected !== 'linux' && detected !== 'other') return detected;
    if (process.argv.includes('--auto') && detected === 'linux') return detectLinuxFamily() || 'linux';
    const choices = [
        ['Windows', 'windows'], ['Termux / Android', 'termux'], ['Linux', 'linux'],
        ['WSL (Windows Subsystem for Linux)', 'wsl'], ['macOS', 'mac'],
    ];
    console.log(`Detected environment: ${detected}${detected === 'linux' ? ` (${detectLinuxFamily() || 'distro unknown'})` : ''}`);
    return ask('Choose the environment used to run this project:', choices);
}
async function chooseLinuxDistro(defaultFamily) {
    const saved = readInstallTarget();
    const forced = process.env.SPOTI_SAVER_DISTRO;
    if (forced) return forced;
    if (saved?.distro && !process.argv.includes('--reselect-platform')) return saved.distro;
    if (defaultFamily && process.argv.includes('--auto')) return defaultFamily;
    const choices = [
        ['Debian / Ubuntu / Mint / Pop!_OS / Kali', 'debian'],
        ['Fedora / RHEL / CentOS / Rocky / Alma', 'fedora'],
        ['Arch / Manjaro', 'arch'], ['openSUSE', 'suse'], ['Alpine', 'alpine'],
    ];
    return ask('Select your Linux distribution family:', choices);
}
function installFor(platform, distro) {
    if (platform === 'termux') return run('pkg', ['install', '-y', '--reinstall', 'yt-dlp', 'ffmpeg']);
    if (platform === 'mac') {
        if (!commandExists('brew')) throw new Error('Homebrew is required on macOS. Install it from https://brew.sh, then run this bootstrap again.');
        return run('brew', ['reinstall', 'yt-dlp', 'ffmpeg']);
    }
    if (platform === 'windows') {
        if (commandExists('winget')) { run('winget', ['install', '--force', '--accept-source-agreements', '--accept-package-agreements', '-e', '--id', 'Gyan.FFmpeg']); return run('winget', ['install', '--force', '--accept-source-agreements', '--accept-package-agreements', '-e', '--id', 'yt-dlp.yt-dlp']); }
        if (commandExists('choco')) return run('choco', ['upgrade', '-y', '--force', 'ffmpeg', 'yt-dlp']);
        if (commandExists('scoop')) return run('scoop', ['update', '--force', 'ffmpeg', 'yt-dlp']);
        throw new Error('Install winget, Chocolatey, or Scoop on Windows, then run this bootstrap again.');
    }
    if (platform === 'linux' || platform === 'wsl') {
        if (distro === 'debian') { sudo('apt-get', ['update']); try { return sudo('apt-get', ['install', '--reinstall', '-y', 'ffmpeg', 'yt-dlp']); } catch (_) { return run('python3', ['-m', 'pip', 'install', '--user', '--upgrade', '--force-reinstall', 'yt-dlp']); } }
        if (distro === 'fedora') return sudo(commandExists('dnf') ? 'dnf' : 'yum', ['reinstall', '-y', 'ffmpeg', 'yt-dlp']);
        if (distro === 'arch') return sudo('pacman', ['-S', '--overwrite', '*', '--noconfirm', 'ffmpeg', 'yt-dlp']);
        if (distro === 'suse') return sudo('zypper', ['--non-interactive', 'install', '--force', 'ffmpeg', 'yt-dlp']);
        if (distro === 'alpine') return sudo('apk', ['add', '--force-overwrite', 'ffmpeg', 'yt-dlp']);
        throw new Error('No supported Linux package manager selected. Install yt-dlp and ffmpeg/ffprobe with your distro tools, then run again.');
    }
    throw new Error('Unsupported environment. Install yt-dlp and FFmpeg manually, then set PATH.');
}
function installNodeDependencies() {
    if (!commandExists('npm')) throw new Error('Node.js/npm is required before setup can continue.');
    run('npm', ['install', '--force', '--ignore-scripts', '--no-audit', '--no-fund']);
}
function verifyNodeDependencies() {
    const names = ['axios', 'node-id3', 'ffmpeg-static', 'dotenv'];
    const paths = names.map(name => {
        try { return [name, require.resolve(name, { paths: [ROOT] })]; } catch (_) { return [name, null]; }
    });
    const missing = paths.filter(([, resolved]) => !resolved);
    paths.forEach(([name, resolved]) => console.log(`   ${name}: ${resolved || 'NOT FOUND'}`));
    if (missing.length) throw new Error(`Node dependencies not resolvable: ${missing.map(([name]) => name).join(', ')}`);
}
function verify() {
    const missing = missingTools();
    if (missing.length) throw new Error(`Bootstrap completed but these commands are still unavailable: ${missing.join(', ')}. Restart the terminal and run node index.js again.`);
    for (const tool of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
        try { console.log(`   ${tool}: ${execFileSync(isWindows() ? 'where' : 'command', isWindows() ? [tool] : ['-v', tool], { encoding: 'utf8', shell: !isWindows() }).trim()}`); }
        catch (_) { throw new Error(`Could not resolve the installed ${tool} path.`); }
    }
    console.log('\n✅ Installation verified: yt-dlp, ffmpeg, and ffprobe are available.');
}
async function main() {
    console.log('=== spoti-saver complete installation ===');
    const saved = readInstallTarget();
    if (saved?.platform && !process.argv.includes('--reselect-platform')) {
        const unavailable = missingTools();
        if (process.argv.includes('--auto') || !process.stdin.isTTY || !process.stdout.isTTY) {
            if (!unavailable.length) {
                console.log(`Saved installation target: ${saved.platform}${saved.distro ? ` (${saved.distro})` : ''}; launching without setup.`);
                return;
            }
            console.log(`Saved target found, but required tools are missing: ${unavailable.join(', ')}. Setup will run automatically.`);
        }
        if (unavailable.length || (process.stdin.isTTY && process.stdout.isTTY)) {
            const action = unavailable.length ? 'setup' : await ask('A saved installation target was found. What would you like to do?', [
                ['Re-run setup and force-reinstall dependencies', 'setup'],
                ['Launch normally without running setup', 'launch'],
            ]);
            if (action === 'launch') {
                console.log('Launching without setup.');
                return;
            }
            if (action !== 'setup') throw new Error('No valid setup action selected.');
            console.log(`Re-running setup for saved target: ${saved.platform}${saved.distro ? ` (${saved.distro})` : ''}`);
        }
    }
    console.log(`Current tools: ${missingTools().length ? `missing ${missingTools().join(', ')}` : 'all present (will reinstall)'}`);
    const platform = await choosePlatform();
    if (!platform) throw new Error('No installation platform selected.');
    const distro = (platform === 'linux' || platform === 'wsl') ? await chooseLinuxDistro(detectLinuxFamily()) : null;
    saveInstallTarget(platform, distro);
    console.log(`\nInstalling for ${platform}${distro ? ` (${distro})` : ''}...`);
    installFor(platform, distro);
    console.log('\nInstalling/reinstalling Node dependencies...');
    installNodeDependencies();
    console.log('\nResolved Node dependency paths:');
    verifyNodeDependencies();
    console.log('\nResolved native dependency paths:');
    verify();
}
main().catch(error => { console.error(`\n❌ Bootstrap failed: ${error.message}`); process.exit(1); });
