@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)
echo Starting IHT Gift Tracker...
start "IHT Gift Tracker" http://localhost:3050
node server.js
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo App failed to start.
pause
exit /b 1
