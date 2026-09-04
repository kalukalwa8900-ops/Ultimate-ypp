@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :error
)
set PORT=8080
node src\index.js
goto :eof
:error
echo Install failed. Make sure Node.js is installed.
pause
