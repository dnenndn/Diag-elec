@echo off
rem Cabinet Mapper - opens the server to the internet through a free Cloudflare quick tunnel.
rem The server must be running (start-server.bat) in its own window. Keep this window open too.
rem The internet address (https://....trycloudflare.com) is NEW each time this file is started.
setlocal
cd /d "%~dp0"
title Cabinet Mapper tunnel

rem the port of the server: PORT in .env (8080 when not set), or give it: start-tunnel.bat 8791
set "PORT=8080"
if exist ".env" for /f "tokens=2 delims== " %%p in ('findstr /r /b /c:"PORT *=" ".env"') do set "PORT=%%p"
if not "%~1"=="" set "PORT=%~1"

if not exist "%~dp0cloudflared.exe" (
  echo  Downloading cloudflared, the free tunnel program of Cloudflare ^(about 60 MB^)...
  curl -L -o "%~dp0cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  if errorlevel 1 ( echo  The download failed. Check the internet connection. & pause & exit /b 1 )
)

rem the server must answer on this PC first, or the tunnel only gives errors 502 / 1033
curl -s -o nul -m 5 "http://127.0.0.1:%PORT%/api/me"
if errorlevel 1 (
  echo.
  echo  The server does not answer on http://127.0.0.1:%PORT%
  echo  Start start-server.bat first, wait until it says "running on port", then start this file again.
  echo  If the server window says another port, give it: start-tunnel.bat 8791   ^(or set PORT=8791 in .env^)
  echo.
  pause
  exit /b 1
)

echo.
echo  Opening the tunnel to http://127.0.0.1:%PORT% ...
echo  In a few seconds, look below for the line with  https://....trycloudflare.com
echo  That is the address to open on the phone ^(in the app: "Connect to a server", with https://^)
echo  or in any browser. It works until this window is closed.
echo.
echo  Over the internet: the drives and the log can be seen, but reset from the phone is refused
echo  ^(it works only on the plant network^). Use strong access codes: anyone with the address can try them.
echo.
"%~dp0cloudflared.exe" tunnel --no-autoupdate --url http://127.0.0.1:%PORT%
echo.
echo  The tunnel stopped.
pause
