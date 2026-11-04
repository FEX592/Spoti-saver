#!/bin/sh
# Spoti-Saver installer and launcher. Menu input comes from the controlling
# terminal so curl-piped installs never try to read choices from the curl pipe.
set -u
APP=spoti-saver
REPO=https://github.com/FEX592/spoti-saver
DATA_HOME=${XDG_DATA_HOME:-${HOME:-.}/.local/share}
INSTALL_DIR="$DATA_HOME/$APP"
command_exists() { command -v "$1" >/dev/null 2>&1; }
log() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; return 1; }
is_termux() { [ -n "${TERMUX_VERSION:-}" ] || case "${PREFIX:-}" in *com.termux*|/data/data/com.termux/*) return 0;; *) return 1;; esac; }
os_family() { case "$(uname -s 2>/dev/null || echo unknown)" in Linux*) if is_termux; then echo termux; else echo linux; fi;; Darwin*) echo macos;; MINGW*|MSYS*|CYGWIN*) echo windows;; *) echo unsupported;; esac; }
launcher_path() { if [ -n "${SPOTI_SAVER_BIN_DIR:-}" ]; then echo "$SPOTI_SAVER_BIN_DIR/spoti-saver"; return; fi; case "$(os_family)" in termux) echo "${PREFIX:-/data/data/com.termux/files/usr}/bin/spoti-saver";; windows) echo "${HOME:-.}/bin/spoti-saver";; *) if [ -w /usr/local/bin ] || command_exists sudo; then echo /usr/local/bin/spoti-saver; else echo "${HOME:-.}/.local/bin/spoti-saver"; fi;; esac; }
fetch_latest() {
    command_exists curl || { fail 'curl is required to download Spoti-Saver.'; return 1; }
    command_exists tar || { fail 'tar is required to extract Spoti-Saver.'; return 1; }
    archive=$(mktemp "${TMPDIR:-/tmp}/spoti-saver.XXXXXX") || return 1
    if ! curl -fsSL --retry 2 --connect-timeout 15 --max-time 180 "$REPO/archive/refs/heads/main.tar.gz" -o "$archive"; then rm -f "$archive"; fail 'Download failed.'; return 1; fi
    mkdir -p "$INSTALL_DIR" || { rm -f "$archive"; return 1; }
    # Extract only into the dedicated application directory; config.json/.env and
    # user data are not removed by updates.
    tar -xzf "$archive" --strip-components=1 -C "$INSTALL_DIR" || { rm -f "$archive"; fail 'Could not extract the archive.'; return 1; }
    rm -f "$archive"
}
ensure_node() {
    command_exists node && command_exists npm && return 0
    case "$(os_family)" in
        termux) command_exists pkg || { fail 'Termux pkg was not found.'; return 1; }; pkg update -y && pkg install -y nodejs || return 1;;
        macos) command_exists brew || { fail 'Install Homebrew, then rerun this installer.'; return 1; }; brew install node || return 1;;
        windows)
            if command_exists winget; then winget install --accept-source-agreements --accept-package-agreements -e --id OpenJS.NodeJS.LTS || return 1
            elif command_exists choco; then choco install -y nodejs-lts || return 1
            else fail 'Install Node.js LTS with winget or Chocolatey, then rerun.'; return 1; fi;;
        linux)
            if command_exists apt-get; then p=apt-get; elif command_exists dnf; then p=dnf; elif command_exists yum; then p=yum; elif command_exists pacman; then p=pacman; elif command_exists apk; then p=apk; else fail 'Install Node.js and npm using your system package manager.'; return 1; fi
            case "$p" in
                apt-get) if command_exists sudo; then sudo apt-get update && sudo apt-get install -y nodejs npm; else apt-get update && apt-get install -y nodejs npm; fi;;
                dnf|yum) if command_exists sudo; then sudo "$p" install -y nodejs npm; else "$p" install -y nodejs npm; fi;;
                pacman) if command_exists sudo; then sudo pacman -S --needed --noconfirm nodejs npm; else pacman -S --needed --noconfirm nodejs npm; fi;;
                apk) if command_exists sudo; then sudo apk add nodejs npm; else apk add nodejs npm; fi;;
            esac || return 1;;
        *) fail 'Unsupported platform; install Node.js LTS and npm, then rerun.'; return 1;;
    esac
    command_exists node && command_exists npm || { fail 'Node.js/npm are not available in PATH.'; return 1; }
}
write_launcher() {
    dest=$1; dir=$(dirname "$dest")
    tmp=$(mktemp "${TMPDIR:-/tmp}/spoti-saver.XXXXXX") || return 1
    printf '#!/bin/sh\n# spoti-saver managed launcher\nexec /bin/sh "%s/start.sh" --run "$@"\n' "$INSTALL_DIR" > "$tmp" || { rm -f "$tmp"; return 1; }
    chmod 755 "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$dir" = /usr/local/bin ] && [ ! -w "$dir" ]; then
        command_exists sudo || { rm -f "$tmp"; fail 'sudo is needed to install the global command.'; return 1; }
        sudo mkdir -p "$dir" && sudo install -m 755 "$tmp" "$dest" || { rm -f "$tmp"; return 1; }
    else mkdir -p "$dir" && install -m 755 "$tmp" "$dest" || { rm -f "$tmp"; return 1; }; fi
    rm -f "$tmp"
    case "$dest" in "${HOME:-/nonexistent}"/*) case ":${PATH:-}:" in *:"$dir":*) ;; *)
        profile="${HOME:-}/.profile"; marker='# spoti-saver managed PATH entry'
        if [ -n "${HOME:-}" ] && ! grep -Fqx "$marker" "$profile" 2>/dev/null; then printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$dir" >> "$profile" || return 1; fi
        ;; esac;; esac
}
remove_launcher() {
    dest=$(launcher_path)
    if [ -f "$dest" ] && grep -q 'spoti-saver managed launcher' "$dest" 2>/dev/null; then
        if [ "$(dirname "$dest")" = /usr/local/bin ] && [ ! -w /usr/local/bin ]; then sudo rm -f "$dest" || return 1; else rm -f "$dest" || return 1; fi
        log "Removed managed launcher: $dest"
    fi
}
setup_app() {
    [ -f "$INSTALL_DIR/index.js" ] || fetch_latest || return 1
    ensure_node || return 1
    setup_log=$(mktemp "${TMPDIR:-/tmp}/spoti-saver-setup.XXXXXX") || return 1
    if is_termux; then
        command_exists pkg || { rm -f "$setup_log"; fail 'Termux pkg was not found.'; return 1; }
        (pkg install -y python ffmpeg && cd "$INSTALL_DIR" && npm install --ignore-scripts --silent --no-audit --no-fund && node "$INSTALL_DIR/bootstrap.js" --auto) >"$setup_log" 2>&1 || {
            cat "$setup_log" >&2; rm -f "$setup_log"; fail 'Setup failed; see the output above.'; return 1;
        }
    else
        (cd "$INSTALL_DIR" && npm install --silent --no-audit --no-fund && node "$INSTALL_DIR/bootstrap.js" --auto) >"$setup_log" 2>&1 || {
            cat "$setup_log" >&2; rm -f "$setup_log"; fail 'Setup failed; see the output above.'; return 1;
        }
    fi
    rm -f "$setup_log"
    write_launcher "$(launcher_path)" || return 1
    log 'Installed/repaired successfully. Run: spoti-saver'
}
install_action() { fetch_latest && setup_app; }
repair_action() {
    if [ ! -f "$INSTALL_DIR/start.sh" ] || [ ! -f "$INSTALL_DIR/index.js" ] || [ ! -f "$INSTALL_DIR/bootstrap.js" ]; then
        log 'Repairing missing application files from the latest release.'; fetch_latest || return 1
    fi
    setup_app
}
update_action() { log 'Updating Spoti-Saver; user configuration and data are preserved.'; fetch_latest && setup_app; }
uninstall_action() {
    remove_launcher || return 1
    if [ -d "$INSTALL_DIR" ]; then
        [ "$INSTALL_DIR" = "$DATA_HOME/spoti-saver" ] || { fail 'Refusing to remove an unexpected path.'; return 1; }
        rm -rf "$INSTALL_DIR" || return 1
        log "Removed Spoti-Saver installation: $INSTALL_DIR"
    else log 'Spoti-Saver installation directory not found.'; fi
    log 'Files outside the dedicated installation directory were not touched.'
}
menu() {
    if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then fail 'Interactive menu needs a terminal. Run this command in an interactive shell.'; return 1; fi
    exec 3<>/dev/tty
    while :; do
        printf '\nSpoti-Saver installer\n  1) Install\n  2) Uninstall\n  3) Repair\n  4) Update\n  0) Exit\nChoose an option: ' > /dev/tty
        IFS= read -r choice <&3 || return 1
        case "$choice" in 1) install_action || log 'Install failed.';; 2) uninstall_action || log 'Uninstall failed.';; 3) repair_action || log 'Repair failed.';; 4) update_action || log 'Update failed.';; 0|q|Q) log 'Goodbye.'; return 0;; *) log 'Choose 1, 2, 3, 4, or 0.';; esac
    done
}
run_app() { [ -f "$INSTALL_DIR/index.js" ] || { fail 'Spoti-Saver is not installed. Run the installer and choose Install.'; return 1; }; ensure_node || return 1; exec node "$INSTALL_DIR/index.js" "$@"; }
case "${1:-}" in
    --run) shift; run_app "$@";;
    --install) setup_app;;
    --uninstall) uninstall_action;;
    --repair) repair_action;;
    --update) update_action;;
    --help|-h) printf 'Usage: start.sh [--run [arguments] | --install | --uninstall | --repair | --update]\n';;
    *)
        # A remote curl|bash invocation has no project files. Install a copy,
        # then show its menu; the menu itself reads from /dev/tty.
        SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P || true)
        if [ ! -f "${SELF_DIR:-}/index.js" ]; then
            fetch_latest || exit 1
            exec /bin/sh "$INSTALL_DIR/start.sh"
        fi
        menu;;
esac
