@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js tidak ditemukan. Hubungi pengelola sistem.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $result = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:4173/api/health' -TimeoutSec 2; if ($result.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  start "Kasir Nusa Server" /min node apps\api\src\server.mjs
  timeout /t 2 /nobreak >nul
)

if /i "%~1"=="--no-browser" exit /b 0
start "" "http://localhost:4173"
endlocal
