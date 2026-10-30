param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $ProjectRoot 'start.sh'
$InstallDir = Join-Path $env:USERPROFILE 'bin'
$Launcher = Join-Path $InstallDir 'spoti-saver.cmd'
$Marker = 'spoti-saver managed launcher'

if (-not (Test-Path $StartScript)) { throw "start.sh was not found at $StartScript" }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathParts = @($userPath -split ';' | Where-Object { $_ })

if ($Uninstall) {
    if (Test-Path $Launcher) {
        $content = Get-Content -Raw $Launcher
        if ($content.Contains($Marker)) {
            Remove-Item -Force $Launcher
            Write-Host "Removed $Launcher"
        } else {
            throw "Refusing to remove an unmanaged launcher: $Launcher"
        }
    } else {
        Write-Host "No managed launcher found at $Launcher"
    }
    return
}

$bash = Get-Command bash.exe -ErrorAction SilentlyContinue
if (-not $bash) { $bash = Get-Command sh.exe -ErrorAction SilentlyContinue }
if (-not $bash) { throw 'Install Git for Windows or enable WSL so a shell can execute start.sh, then run this installer again.' }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$escapedBash = $bash.Source.Replace('"', '""')
$escapedStart = $StartScript.Replace('"', '""')
@("@echo off", "rem $Marker", "`"$escapedBash`" `"$escapedStart`" %*") | Set-Content -Encoding ASCII -Path $Launcher

if (-not ($pathParts | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') })) {
    $pathParts += $InstallDir
    [Environment]::SetEnvironmentVariable('Path', ($pathParts -join ';'), 'User')
    Write-Host "Added $InstallDir to the user PATH. Open a new terminal to use it."
}
Write-Host "Installed global command: $Launcher"
Write-Host 'Open a new terminal and type: spoti-saver'
