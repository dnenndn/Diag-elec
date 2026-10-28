@echo off
rem Cabinet Mapper - lets phones on the network reach the server through the Windows firewall.
rem It asks for administrator rights once (Windows shows a Yes/No window).
setlocal
cd /d "%~dp0"
set "PORT=8080"
if exist ".env" for /f "tokens=2 delims== " %%p in ('findstr /r /b /c:"PORT *=" ".env"') do set "PORT=%%p"
if not "%~1"=="" set "PORT=%~1"

net session >nul 2>nul
if errorlevel 1 (
  echo  Asking Windows for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%PORT%' -Verb RunAs"
  exit /b 0
)

title Cabinet Mapper firewall
echo.
echo  Opening TCP port %PORT% for Cabinet Mapper in the Windows firewall...
netsh advfirewall firewall delete rule name="Cabinet Mapper server" >nul 2>nul
netsh advfirewall firewall add rule name="Cabinet Mapper server" dir=in action=allow protocol=TCP localport=%PORT% profile=any
if errorlevel 1 ( echo  It did not work. & pause & exit /b 1 )
echo.
echo  Done. Phones on the same network can now open:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f %%b in ("%%a") do echo     http://%%b:%PORT%
echo.
echo  Use the address on the same network as the phone ^(often 192.168.x.x of the Wi-Fi^).
pause
