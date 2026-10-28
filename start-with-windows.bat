@echo off
rem Cabinet Mapper - makes the server start by itself when you sign in to Windows (or removes that).
setlocal
cd /d "%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Cabinet Mapper server.lnk"

if exist "%LNK%" (
  echo  The server already starts with Windows.
  choice /c YN /m " Stop starting it with Windows"
  if errorlevel 2 exit /b 0
  del "%LNK%"
  echo  Done: the server no longer starts with Windows.
  pause
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath='%~dp0start-server.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Cabinet Mapper server'; $s.Save()"
if exist "%LNK%" (
  echo  Done: the server starts by itself, minimized, each time you sign in to Windows.
  echo  Also set the PC never to sleep: Settings, System, Power, Sleep: Never.
) else (
  echo  The shortcut could not be made. Do it by hand: Win+R, type shell:startup,
  echo  and put a shortcut to start-server.bat in the folder that opens.
)
pause
