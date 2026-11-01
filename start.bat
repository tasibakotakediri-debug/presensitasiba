@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Instal Node.js terlebih dahulu.
  pause
  exit /b 1
)
echo Tasiba 26 berjalan di http://127.0.0.1:3000
echo Biarkan jendela ini tetap terbuka selama aplikasi digunakan.
node server.js
pause
