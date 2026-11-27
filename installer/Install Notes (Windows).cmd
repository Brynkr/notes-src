@echo off
rem Double-click to install Notes for this Windows user (no admin needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation did not finish. See the message above.
)
pause
