# Notes installer for Windows (per user, no admin rights needed).
#
#   Double-click "Install Notes (Windows).cmd", or run:
#   powershell -ExecutionPolicy Bypass -File installer\install.ps1 [-NoStartup] [-NoLaunch] [-Yes]
#
# Installs to %LOCALAPPDATA%\Programs\notes-app, adds a Start menu entry,
# starts the notes server at login (unless -NoStartup), and registers an
# uninstaller under Settings > Apps. Your notes and settings are never touched.

param(
  [switch]$NoStartup,
  [switch]$NoLaunch,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Release zip: the app is in "app" beside the installer folder. Source
# checkout: it's the build output in "dist" (run "npm run build" first).
$Source = Join-Path (Split-Path -Parent $Here) 'app'
$FromSource = $false
if (-not (Test-Path (Join-Path $Source 'server.js'))) {
  $Dist = Join-Path (Split-Path -Parent $Here) 'dist'
  if ((Test-Path (Join-Path $Dist 'server.js')) -or (Test-Path (Join-Path (Split-Path -Parent $Here) 'package.json'))) {
    $Source = $Dist
    $FromSource = $true
  }
}
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\notes-app'
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Notes.lnk'
$StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Notes (background).lnk'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\notes-app'

function Say($msg) { Write-Host "  $msg" }
function Ask($question) {
  if ($Yes) { return $true }
  $answer = Read-Host "  $question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Node-Ok {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  $v = (& $cmd.Source --version) -replace '^v', ''
  $parts = $v.Split('.')
  return ([int]$parts[0] -gt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 13)
}
function Winget-Install($id, $what) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$what is missing and winget isn't available. Install $what yourself, then run this again."
  }
  if (-not (Ask "$what is needed. Install it now with winget?")) { throw "$what is required." }
  & winget install --id $id -e --source winget --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget couldn't install $what (exit $LASTEXITCODE)." }
  Refresh-Path
}

Write-Host ''
Write-Host 'Installing Notes' -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $Source 'server.js'))) {
  if ($FromSource) { throw "This is the source folder and the app isn't built yet. Run 'npm install' and 'npm run build' in $(Split-Path -Parent $Here), then run the installer again." }
  throw "Can't find the app files next to the installer ($Source). Extract the whole zip first."
}

# 1. Prerequisites
if (-not (Node-Ok)) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js 22 or newer' }
if (-not (Node-Ok)) { throw 'Node.js 22.13 or newer is still not on the PATH. Open a new terminal and run the installer again.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Winget-Install 'Git.Git' 'Git' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is still not on the PATH. Open a new terminal and run the installer again.' }
$Node = (Get-Command node).Source
Say "Node.js: $Node ($(& $Node --version))"
Say "git:     $((Get-Command git).Source)"

# 2. Stop a running copy (it syncs first), then copy the app
if (Test-Path (Join-Path $Dest 'server.js')) {
  $old = Join-Path $Dest 'server.js'
  & $Node $old stop | Out-Null
  # Wait until it has really exited (final sync, up to ~10 s). If it won't stop,
  # say so rather than install a version that isn't the one running.
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    & $Node $old running | Out-Null
  } while ($LASTEXITCODE -eq 0 -and (Get-Date) -lt $deadline)
  if ($LASTEXITCODE -eq 0) {
    throw 'Notes is still running and did not stop when asked. Quit it (or sign out and back in), then run the installer again.'
  }
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Get-ChildItem $Dest -Exclude 'uninstall.ps1' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $Source '*') $Dest
# From a source checkout, dist\ also holds source maps; the release zip leaves them out.
if ($FromSource) { Get-ChildItem $Dest -Recurse -Filter '*.map' | Remove-Item -Force }
Copy-Item -Force (Join-Path $Here 'uninstall.ps1') $Dest
Copy-Item -Force (Join-Path $Here 'assets\icon.ico') $Dest
Say "Installed to $Dest"

# 3. Shortcuts. "launch" starts the server in the background if needed and
#    opens the app window; WindowStyle 7 keeps the brief console minimised.
$shell = New-Object -ComObject WScript.Shell
function Make-Shortcut($path, $arguments) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $Node
  $lnk.Arguments = "`"$Dest\server.js`" $arguments"
  $lnk.WorkingDirectory = $Dest
  $lnk.IconLocation = "$Dest\icon.ico"
  $lnk.WindowStyle = 7
  $lnk.Description = 'Git-backed Markdown notes'
  $lnk.Save()
}
Make-Shortcut $StartMenu 'launch'
Say 'Added "Notes" to the Start menu (right-click it to pin to the taskbar).'
if ($NoStartup) {
  if (Test-Path $StartupLnk) { Remove-Item $StartupLnk -Force }
} else {
  Make-Shortcut $StartupLnk 'launch --no-window'
  Say 'Notes will sync in the background from login.'
}

# 4. Settings > Apps entry
New-Item -Path $UninstallKey -Force | Out-Null
$version = (& $Node (Join-Path $Dest 'server.js') version)
Set-ItemProperty $UninstallKey -Name DisplayName -Value 'Notes'
Set-ItemProperty $UninstallKey -Name DisplayVersion -Value $version
Set-ItemProperty $UninstallKey -Name Publisher -Value 'notes-app'
Set-ItemProperty $UninstallKey -Name DisplayIcon -Value "$Dest\icon.ico"
Set-ItemProperty $UninstallKey -Name InstallLocation -Value $Dest
Set-ItemProperty $UninstallKey -Name UninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dest\uninstall.ps1`""
Set-ItemProperty $UninstallKey -Name NoModify -Value 1 -Type DWord
Set-ItemProperty $UninstallKey -Name NoRepair -Value 1 -Type DWord

Write-Host ''
Write-Host "Done. Notes $version is installed." -ForegroundColor Green
if (-not $NoLaunch) {
  & $Node (Join-Path $Dest 'server.js') launch
  Say 'Opening Notes. The first time, it asks where to keep your notes.'
}
