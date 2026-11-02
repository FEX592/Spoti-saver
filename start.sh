#!/bin/sh
# Spoti-Saver launcher: manages Node.js only, then delegates all application
# setup to index.js. It is intentionally POSIX-sh compatible.
set -u

# A curl-piped invocation has no project directory; bootstrap a persistent copy.
if [ ! -f "$(dirname -- "$0")/index.js" ] && [ "${BASH_VERSION:-}" != "" ]; then
    command -v curl >/dev/null 2>&1 || { printf '%s\n' '❌ curl is required for direct installation.' >&2; exit 1; }
    command -v tar >/dev/null 2>&1 || { printf '%s\n' '❌ tar is required for direct installation.' >&2; exit 1; }
    install_dir="${XDG_DATA_HOME:-${HOME:-.}/.local/share}/spoti-saver"
    archive=$(mktemp "${TMPDIR:-/tmp}/spoti-saver.XXXXXX") || { printf '%s\n' '❌ Could not create a temporary download.' >&2; exit 1; }
    trap 'rm -f "$archive"' EXIT HUP INT TERM
    printf '%s\n' '📥 Downloading Spoti-Saver...'
    curl_log=$(mktemp "${TMPDIR:-/tmp}/spoti-saver-curl.XXXXXX") || { printf '%s\n' '❌ Could not create a temporary download log.' >&2; exit 1; }
    curl_status="${archive}.status"
    start_time=$(date +%s)
    (curl --fail --location --show-error --silent \
        --connect-timeout 15 --max-time 180 --retry 2 --retry-all-errors --retry-delay 2 \
        'https://github.com/FEX592/Spoti-saver/archive/refs/heads/main.tar.gz' -o "$archive" 2>"$curl_log"
        result=$?
        printf '%s\n' "$result" > "$curl_status"
    ) &
    download_pid=$!
    while [ ! -f "$curl_status" ]; do
        sleep 5
        [ -f "$curl_status" ] && break
        now=$(date +%s)
        elapsed=$((now - start_time))
        bytes=$(wc -c < "$archive" 2>/dev/null || printf '0')
        megabytes=$(awk -v bytes="$bytes" 'BEGIN { printf "%.1f", bytes / 1048576 }')
        if [ "$bytes" -gt 0 ]; then
            printf '📥 Downloading Spoti-Saver: %s MB received (%ss elapsed)\n' "$megabytes" "$elapsed"
        else
            printf '⏳ Connecting to GitHub for Spoti-Saver download (%ss elapsed; no data received yet)\n' "$elapsed"
        fi
    done
    wait "$download_pid" || true
    curl_result=$(cat "$curl_status" 2>/dev/null || printf '1')
    rm -f "$curl_status"
    if [ "$curl_result" != '0' ]; then
        cat "$curl_log" >&2
        rm -f "$curl_log"
        printf '%s\n' '❌ Spoti-Saver download failed or timed out after retries. Check your internet connection and try again.' >&2
        exit 1
    fi
    rm -f "$curl_log"
    bytes=$(wc -c < "$archive" 2>/dev/null || printf '0')
    megabytes=$(awk -v bytes="$bytes" 'BEGIN { printf "%.1f", bytes / 1048576 }')
    printf '✅ Spoti-Saver download complete (%s MB).\n' "$megabytes"
    mkdir -p "$install_dir" || { printf '%s\n' '❌ Could not create the installation directory.' >&2; exit 1; }
    tar -xzf "$archive" --strip-components=1 -C "$install_dir" || { printf '%s\n' '❌ Could not extract Spoti-Saver.' >&2; exit 1; }
    rm -f "$archive"
    trap - EXIT HUP INT TERM
    /bin/sh "$install_dir/start.sh" --install || exit 1
    exec /bin/sh "$install_dir/start.sh" "$@"
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || {
    printf '%s\n' '❌ Could not resolve the Spoti-Saver project directory.' >&2
    exit 1
}

APP_ENTRY="$SCRIPT_DIR/index.js"

log() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "❌ $*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

if [ ! -f "$APP_ENTRY" ]; then
    fail "index.js was not found in: $SCRIPT_DIR"
fi

# Returns 0 for Termux, including launches where process.platform is Linux.
is_termux() {
    [ "${TERMUX_VERSION:-}" != "" ] ||
    case "${PREFIX:-}" in
        *com.termux*|/data/data/com.termux/*) return 0 ;;
        *) return 1 ;;
    esac
}

# Detect the host family used by this shell. Git Bash/MSYS/Cygwin are treated
# as Windows-compatible shells and use winget/Chocolatey when available.
OS_FAMILY='unsupported'
case "$(uname -s 2>/dev/null || printf unknown)" in
    Linux*)
        if is_termux; then OS_FAMILY='termux'
        elif [ "${WSL_DISTRO_NAME:-}" != "" ] || [ "${WSL_INTEROP:-}" != "" ]; then OS_FAMILY='wsl'
        elif grep -qi microsoft /proc/version 2>/dev/null; then OS_FAMILY='wsl'
        else OS_FAMILY='linux'
        fi
        ;;
    Darwin*) OS_FAMILY='macos' ;;
    MINGW*|MSYS*|CYGWIN*) OS_FAMILY='windows' ;;
    *) OS_FAMILY='unsupported' ;;
esac

launcher_path() {
    if [ "$OS_FAMILY" = 'termux' ]; then
        printf '%s\n' "${PREFIX:-/data/data/com.termux/files/usr}/bin/spoti-saver"
    elif [ "$OS_FAMILY" = 'windows' ]; then
        printf '%s\n' "${HOME:-.}/bin/spoti-saver"
    elif [ -w /usr/local/bin ]; then
        printf '%s\n' '/usr/local/bin/spoti-saver'
    elif command_exists sudo; then
        printf '%s\n' '/usr/local/bin/spoti-saver'
    else
        printf '%s\n' "${HOME:-.}/.local/bin/spoti-saver"
    fi
}

write_launcher() {
    destination="$1"
    target="$SCRIPT_DIR/start.sh"
    wrapper=$(mktemp "${TMPDIR:-/tmp}/spoti-saver.XXXXXX") || fail 'Could not create a temporary launcher.'
    {
        printf '%s\n' '#!/bin/sh' '# spoti-saver managed launcher; do not edit.'
        printf 'exec /bin/sh "%s/start.sh" "$@"\n' "$SCRIPT_DIR"
    } > "$wrapper" || fail 'Could not write the launcher.'
    chmod +x "$wrapper" || fail 'Could not make the launcher executable.'
    if [ "$(dirname -- "$destination")" = '/usr/local/bin' ] && [ ! -w /usr/local/bin ]; then
        command_exists sudo || fail 'Administrator permission is required to install /usr/local/bin/spoti-saver.'
        sudo mkdir -p /usr/local/bin && sudo install -m 755 "$wrapper" "$destination" || fail 'Could not install the global launcher.'
    else
        mkdir -p "$(dirname -- "$destination")" || fail 'Could not create the launcher directory.'
        install -m 755 "$wrapper" "$destination" || fail 'Could not install the global launcher.'
    fi
    rm -f "$wrapper"
}

add_user_path() {
    directory="$1"
    case ":${PATH:-}:" in *:"$directory":*) return 0 ;; esac
    profile="${HOME:-}/.profile"
    [ -n "${HOME:-}" ] || return 0
    marker='# spoti-saver adds its launcher directory'
    if [ ! -f "$profile" ] || ! grep -Fqx "$marker" "$profile" 2>/dev/null; then
        {
            printf '\n%s\n' "$marker"
            printf 'export PATH="%s:$PATH"\n' "$directory"
        } >> "$profile" || fail "Could not update $profile. Add $directory to PATH manually."
        log "✅ Added $directory to PATH for future terminal sessions."
    fi
}

install_global_command() {
    destination=$(launcher_path)
    log "🔗 Installing global command: $destination"
    write_launcher "$destination"
    case "$destination" in
        "$HOME"/*) add_user_path "$(dirname -- "$destination")" ;;
    esac
    log '✅ Global command installed. Open a new terminal, then type: spoti-saver'
}

uninstall_global_command() {
    destination=$(launcher_path)
    if [ -f "$destination" ] && grep -q 'spoti-saver managed launcher' "$destination" 2>/dev/null; then
        if [ "$(dirname -- "$destination")" = '/usr/local/bin' ] && [ ! -w /usr/local/bin ]; then sudo rm -f "$destination"; else rm -f "$destination"; fi
        log "✅ Removed global command: $destination"
    else
        log "ℹ️ No Spoti-Saver-managed launcher found at: $destination"
    fi
}

case "${1:-}" in
    --install)
        install_global_command
        exit 0
        ;;
    --uninstall)
        uninstall_global_command
        exit 0
        ;;
    --help|-h)
        log 'Usage: ./start.sh [--install|--uninstall|application arguments]'
        log '  --install    Register the global spoti-saver terminal command.'
        log '  --uninstall  Remove the managed global terminal command.'
        exit 0
        ;;
esac

install_node() {
    case "$OS_FAMILY" in
        termux)
            command_exists pkg || fail 'Termux package manager (pkg) was not found. Install current Termux from F-Droid/GitHub and try again.'
            log '📦 Installing Node.js with Termux pkg...'
            pkg update -y || fail 'Termux package index update failed.'
            pkg install -y nodejs || fail 'Node.js installation failed in Termux.'
            ;;
        macos)
            command_exists brew || fail 'Node.js is missing. Install Homebrew from https://brew.sh, then run start.sh again.'
            log '📦 Installing Node.js with Homebrew...'
            brew install node || fail 'Node.js installation failed with Homebrew.'
            ;;
        windows)
            if command_exists winget; then
                log '📦 Installing Node.js with winget...'
                winget install --accept-source-agreements --accept-package-agreements -e --id OpenJS.NodeJS.LTS || fail 'Node.js installation failed with winget.'
            elif command_exists choco; then
                log '📦 Installing Node.js with Chocolatey...'
                choco install -y nodejs-lts || fail 'Node.js installation failed with Chocolatey.'
            else
                fail 'Node.js is missing. Install Node.js LTS with winget or Chocolatey, then run start.sh again.'
            fi
            ;;
        linux|wsl)
            if command_exists apt-get; then
                log '📦 Installing Node.js with apt...'
                if command_exists sudo; then sudo apt-get update && sudo apt-get install -y nodejs npm
                else apt-get update && apt-get install -y nodejs npm
                fi || fail 'Node.js installation failed with apt.'
            elif command_exists dnf; then
                log '📦 Installing Node.js with dnf...'
                if command_exists sudo; then sudo dnf install -y nodejs npm
                else dnf install -y nodejs npm
                fi || fail 'Node.js installation failed with dnf.'
            elif command_exists yum; then
                log '📦 Installing Node.js with yum...'
                if command_exists sudo; then sudo yum install -y nodejs npm
                else yum install -y nodejs npm
                fi || fail 'Node.js installation failed with yum.'
            elif command_exists pacman; then
                log '📦 Installing Node.js with pacman...'
                if command_exists sudo; then sudo pacman -Sy --needed --noconfirm nodejs npm
                else pacman -Sy --needed --noconfirm nodejs npm
                fi || fail 'Node.js installation failed with pacman.'
            elif command_exists apk; then
                log '📦 Installing Node.js with apk...'
                if command_exists sudo; then sudo apk add nodejs npm
                else apk add nodejs npm
                fi || fail 'Node.js installation failed with apk.'
            else
                fail 'Node.js is missing and no supported package manager was found. Install Node.js LTS from https://nodejs.org, then run start.sh again.'
            fi
            ;;
        *)
            fail 'Unsupported operating system. Install Node.js LTS from https://nodejs.org, then run start.sh again.'
            ;;
    esac
}

update_node() {
    case "$OS_FAMILY" in
        termux)
            log '🔄 Checking Node.js updates with Termux pkg...'
            pkg upgrade -y nodejs || fail 'Node.js update check failed in Termux.'
            ;;
        macos)
            command_exists brew || fail 'Homebrew is unavailable, so Node.js cannot be updated automatically.'
            log '🔄 Checking Node.js updates with Homebrew...'
            brew update && brew upgrade node || fail 'Node.js update check failed with Homebrew.'
            ;;
        windows)
            if command_exists winget; then
                log '🔄 Checking Node.js updates with winget...'
                winget upgrade --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements || true
            elif command_exists choco; then
                log '🔄 Checking Node.js updates with Chocolatey...'
                choco upgrade -y nodejs-lts || fail 'Node.js update check failed with Chocolatey.'
            else
                log '⚠️ No supported Windows package manager found; leaving the installed Node.js unchanged.'
            fi
            ;;
        linux|wsl)
            # Package-manager update commands are deliberately scoped to Node.js;
            # this script must not upgrade the whole operating system.
            if command_exists apt-get; then
                log '🔄 Checking Node.js updates with apt...'
                if command_exists sudo; then sudo apt-get install --only-upgrade -y nodejs npm
                else apt-get install --only-upgrade -y nodejs npm
                fi || fail 'Node.js update check failed with apt.'
            elif command_exists dnf; then
                log '🔄 Checking Node.js updates with dnf...'
                if command_exists sudo; then sudo dnf upgrade -y nodejs npm
                else dnf upgrade -y nodejs npm
                fi || fail 'Node.js update check failed with dnf.'
            elif command_exists yum; then
                log '🔄 Checking Node.js updates with yum...'
                if command_exists sudo; then sudo yum update -y nodejs npm
                else yum update -y nodejs npm
                fi || fail 'Node.js update check failed with yum.'
            elif command_exists pacman; then
                log '🔄 Checking Node.js updates with pacman...'
                if command_exists sudo; then sudo pacman -Syu --needed --noconfirm nodejs npm
                else pacman -Syu --needed --noconfirm nodejs npm
                fi || fail 'Node.js update check failed with pacman.'
            elif command_exists apk; then
                log '🔄 Checking Node.js updates with apk...'
                if command_exists sudo; then sudo apk upgrade nodejs npm
                else apk upgrade nodejs npm
                fi || fail 'Node.js update check failed with apk.'
            else
                log '⚠️ No supported Linux package manager found; leaving Node.js unchanged.'
            fi
            ;;
        *) log '⚠️ Automatic Node.js updates are unavailable for this operating system.' ;;
    esac
}

if command_exists node; then
    log "✅ Node.js found: $(command -v node)"
    node --version || fail 'The installed node command could not be executed.'
    update_node
else
    log 'ℹ️ Node.js was not found.'
    install_node
fi

# Package managers may update PATH only for future shells. Refresh the common
# native bin locations before checking again, without touching application setup.
case "$OS_FAMILY" in
    termux) export PATH="${PREFIX:-/data/data/com.termux/files/usr}/bin:$PATH" ;;
    macos) [ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"; [ -d /usr/local/bin ] && export PATH="/usr/local/bin:$PATH" ;;
esac

command_exists node || fail 'Node.js installation completed, but node is still not available in PATH. Restart the terminal and run start.sh again.'
log "🚀 Launching Spoti-Saver from: $SCRIPT_DIR"
exec node "$APP_ENTRY" "$@"
