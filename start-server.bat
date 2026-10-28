@echo off
rem Cabinet Mapper - starts the server and keeps it running.
rem If the server stops (an error, a crash), it is started again after 10 seconds, so the machine log goes on.
rem Close this window, or press Ctrl+C then Y, to stop it.
setlocal
cd /d "%~dp0"
title Cabinet Mapper server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this PC.
  echo  Install the LTS version from https://nodejs.org ^(keep the default options^),
  echo  then start this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 (
  echo  Node.js is too old ^(version %NODEMAJOR%^). Install the LTS version from https://nodejs.org
  pause
  exit /b 1
)
if not exist ".env" if exist ".env.example" (
  copy /y ".env.example" ".env" >nul
  echo  A settings file .env was made from .env.example. Edit it with Notepad if needed.
)

set "PORT=8080"
if exist ".env" for /f "tokens=2 delims== " %%p in ('findstr /r /b /c:"PORT *=" ".env"') do set "PORT=%%p"
echo.
echo  Cabinet Mapper server
echo  ---------------------
echo  On this PC open:        http://localhost:%PORT%
echo  On the phone, use one of these addresses of this PC ^(same network^):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f %%b in ("%%a") do echo     http://%%b:%PORT%
echo  Internet: start-tunnel.bat ^(it uses the same port, %PORT%^).
echo.

:run
echo [%date% %time%] Starting the server...
node server.js
echo.
echo [%date% %time%] The server stopped ^(code %errorlevel%^). It starts again in 10 seconds.
echo  Close this window to stop it for good.
timeout /t 10 /nobreak >nul
goto run
