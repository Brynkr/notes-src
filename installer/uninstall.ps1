# Removes the Notes app for this user. Your notes folder, settings
# (%APPDATA%\notes-app) and search index (%LOCALAPPDATA%\notes-app) are kept.

$ErrorActionPreference = 'Continue'
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\notes-app'
$node = Get-Command node -ErrorAction SilentlyContinue

if ($node -and (Test-Path (Join-Path $Dest 'server.js'))) {
  $old = Join-Path $Dest 'server.js'
  & $node.Source $old stop | Out-Null
  # Wait until it has really exited (it syncs first, up to ~10 s).
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    & $node.Source $old running | Out-Null
  } while ($LASTEXITCODE -eq 0 -and (Get-Date) -lt $deadline)
  if ($LASTEXITCODE -eq 0) { Write-Warning 'Notes is still running; it will stop when you sign out.' }
}
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Notes.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'Notes (background).lnk') -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\notes-app' -Recurse -Force -ErrorAction SilentlyContinue
# This script lives in $Dest, so delete the folder once it has exited.
Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c', "ping -n 3 127.0.0.1 >nul & rmdir /s /q `"$Dest`""
Write-Host 'Notes has been removed. Your notes and settings were left in place.'
