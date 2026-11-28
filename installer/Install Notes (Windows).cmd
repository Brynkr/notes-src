@echo off
rem Double-click to install Notes for this Windows user (no admin needed).
rem Works from the release zip (installer\install.ps1 beside this file) and
rem from the source folder (install.ps1 next to this file, app from dist\).
set "PS1=%~dp0installer\install.ps1"
if not exist "%PS1%" set "PS1=%~dp0install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
if errorlevel 1 (
  echo.
  echo Installation did not finish. See the message above.
)
pause
