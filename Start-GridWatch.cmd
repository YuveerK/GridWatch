@echo off
setlocal
cd /d "%~dp0api"
if not exist .env (
  echo GridWatch configuration is missing from api/.env.
  pause
  exit /b 1
)
if not exist ..\client\dist\index.html (
  echo Build the web app first: cd client then npm run build.
  pause
  exit /b 1
)
set SCHEDULER=off
set SERVE_WEB_CLIENT=on
set HOST=127.0.0.1
echo Open http://localhost:4000/review in your browser.
echo GridWatch runs in this window. Press Ctrl+C to stop it.
echo Automatic fetching is paused; use Fetch latest posts when you choose.
node src/server.js
exit /b %errorlevel%
