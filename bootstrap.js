#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

if (process.env.PREFIX) {
    const termuxBin = path.join(process.env.PREFIX, 'bin');
    const pathParts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (!pathParts.includes(termuxBin)) process.env.PATH = [termuxBin, ...pathParts].join(path.delimiter);
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
    const detected = detectedPlatform();
    const forced = process.env.SPOTI_SAVER_PLATFORM;
    if (forced) return forced;
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
    const forced = process.env.SPOTI_SAVER_DISTRO;
    if (forced) return forced;
    if (defaultFamily && process.argv.includes('--auto')) return defaultFamily;
    const choices = [
        ['Debian / Ubuntu / Mint / Pop!_OS / Kali', 'debian'],
        ['Fedora / RHEL / CentOS / Rocky / Alma', 'fedora'],
        ['Arch / Manjaro', 'arch'], ['openSUSE', 'suse'], ['Alpine', 'alpine'],
    ];
    return ask('Select your Linux distribution family:', choices);
}
function installFor(platform, distro) {
    if (platform === 'termux') return run('pkg', ['install', '-y', 'yt-dlp', 'ffmpeg']);
    if (platform === 'mac') {
        if (!commandExists('brew')) throw new Error('Homebrew is required on macOS. Install it from https://brew.sh, then run this bootstrap again.');
        return run('brew', ['install', 'yt-dlp', 'ffmpeg']);
    }
    if (platform === 'windows') {
        if (commandExists('winget')) { run('winget', ['install', '--accept-source-agreements', '--accept-package-agreements', '-e', '--id', 'Gyan.FFmpeg']); return run('winget', ['install', '--accept-source-agreements', '--accept-package-agreements', '-e', '--id', 'yt-dlp.yt-dlp']); }
        if (commandExists('choco')) return run('choco', ['install', '-y', 'ffmpeg', 'yt-dlp']);
        if (commandExists('scoop')) return run('scoop', ['install', 'ffmpeg', 'yt-dlp']);
        throw new Error('Install winget, Chocolatey, or Scoop on Windows, then run this bootstrap again.');
    }
    if (platform === 'linux' || platform === 'wsl') {
        if (distro === 'debian') { sudo('apt-get', ['update']); try { return sudo('apt-get', ['install', '-y', 'ffmpeg', 'yt-dlp']); } catch (_) { return run('python3', ['-m', 'pip', 'install', '--user', 'yt-dlp']); } }
        if (distro === 'fedora') return sudo(commandExists('dnf') ? 'dnf' : 'yum', ['install', '-y', 'ffmpeg', 'yt-dlp']);
        if (distro === 'arch') return sudo('pacman', ['-S', '--needed', '--noconfirm', 'ffmpeg', 'yt-dlp']);
        if (distro === 'suse') return sudo('zypper', ['--non-interactive', 'install', 'ffmpeg', 'yt-dlp']);
        if (distro === 'alpine') return sudo('apk', ['add', 'ffmpeg', 'yt-dlp']);
        throw new Error('No supported Linux package manager selected. Install yt-dlp and ffmpeg/ffprobe with your distro tools, then run again.');
    }
    throw new Error('Unsupported environment. Install yt-dlp and FFmpeg manually, then set PATH.');
}
function verify() {
    const missing = missingTools();
    if (missing.length) throw new Error(`Bootstrap completed but these commands are still unavailable: ${missing.join(', ')}. Restart the terminal and run node index.js again.`);
    console.log('\n✅ Installation verified: yt-dlp, ffmpeg, and ffprobe are available.');
}
async function main() {
    const missing = missingTools();
    if (!missing.length) { console.log('✅ yt-dlp, ffmpeg, and ffprobe are already installed.'); return; }
    console.log(`Missing tools: ${missing.join(', ')}`);
    const platform = await choosePlatform();
    if (!platform) throw new Error('No installation platform selected.');
    const distro = (platform === 'linux' || platform === 'wsl') ? await chooseLinuxDistro(detectLinuxFamily()) : null;
    console.log(`\nInstalling for ${platform}${distro ? ` (${distro})` : ''}...`);
    installFor(platform, distro);
    verify();
}
main().catch(error => { console.error(`\n❌ Bootstrap failed: ${error.message}`); process.exit(1); });
