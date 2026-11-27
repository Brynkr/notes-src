# Removes the Notes app for this user. Your notes folder, settings
# (%APPDATA%\notes-app) and search index (%LOCALAPPDATA%\notes-app) are kept.

$ErrorActionPreference = 'Continue'
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\notes-app'
$node = Get-Command node -ErrorAction SilentlyContinue

if ($node -and (Test-Path (Join-Path $Dest 'server.js'))) {
  & $node.Source (Join-Path $Dest 'server.js') stop | Out-Null
  Start-Sleep -Seconds 3
}
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Notes.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'Notes (background).lnk') -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\notes-app' -Recurse -Force -ErrorAction SilentlyContinue
# This script lives in $Dest, so delete the folder once it has exited.
Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c', "ping -n 3 127.0.0.1 >nul & rmdir /s /q `"$Dest`""
Write-Host 'Notes has been removed. Your notes and settings were left in place.'
