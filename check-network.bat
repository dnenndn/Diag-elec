@echo off
rem Cabinet Mapper - finds why a phone on the network cannot open the server. Nothing is changed.
setlocal
cd /d "%~dp0"
title Cabinet Mapper network check
set "PORT=8080"
if exist ".env" for /f "tokens=2 delims== " %%p in ('findstr /r /b /c:"PORT *=" ".env"') do set "PORT=%%p"
if not "%~1"=="" set "PORT=%~1"
set "OUT=%~dp0network-check.txt"

> "%OUT%" echo Cabinet Mapper network check, %date% %time%, port %PORT%
>>"%OUT%" echo.
>>"%OUT%" echo === 1. Is the server listening, and on which addresses ===
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >>"%OUT%"
if errorlevel 1 >>"%OUT%" echo NOT LISTENING on port %PORT%: start start-server.bat first.
>>"%OUT%" echo.
>>"%OUT%" echo === 2. The addresses of this PC, network by network ===
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | ForEach-Object { $p=(Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue); '{0,-16} {1,-30} network type: {2}' -f $_.IPAddress, $_.InterfaceAlias, $(if($p){$p.NetworkCategory}else{'?'}) }" >>"%OUT%"
>>"%OUT%" echo.
>>"%OUT%" echo === 3. Does the server answer on each address, from this PC ===
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '169.254.*'} | ForEach-Object {$_.IPAddress}"`) do (
  curl -s -o nul -m 4 -w "http://%%i:%PORT%  -> HTTP %%{http_code}\n" "http://%%i:%PORT%/api/me" >>"%OUT%" || >>"%OUT%" echo http://%%i:%PORT%  -^> NO ANSWER
)
>>"%OUT%" echo.
>>"%OUT%" echo === 4. Windows firewall: rules for the port and for Node.js ===
netsh advfirewall firewall show rule name="Cabinet Mapper server" >>"%OUT%" 2>&1
powershell -NoProfile -Command "Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object {$_.Program -like '*node.exe'} | ForEach-Object { $r=$_ | Get-NetFirewallRule; '{0} | {1} | {2} | profiles: {3}' -f $r.DisplayName,$r.Direction,$r.Action,$r.Profile }" >>"%OUT%" 2>&1
netsh advfirewall show allprofiles state >>"%OUT%" 2>&1
>>"%OUT%" echo.
>>"%OUT%" echo === 5. Programs that may also filter the network ===
powershell -NoProfile -Command "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue | ForEach-Object {$_.displayName}; Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | ForEach-Object {$_.displayName}" >>"%OUT%" 2>&1

type "%OUT%"
echo.
echo  This was saved in network-check.txt. Send it, with what the phone's Chrome shows for
echo  http://^<address of step 2^>:%PORT%   ^("took too long" or "refused"^).
pause
