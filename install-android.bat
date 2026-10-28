@echo off
rem Cabinet Mapper - installs or updates the phone app (CabinetMapper.apk) on an Android phone connected by USB.
rem On the phone, once: Settings, About phone, tap "Build number" 7 times; then Settings, Developer options, turn on "USB debugging".
setlocal
cd /d "%~dp0"
title Install Cabinet Mapper on the phone

set "APK="
if exist "%~dp0CabinetMapper.apk" set "APK=%~dp0CabinetMapper.apk"
if exist "%~dp0public\CabinetMapper.apk" set "APK=%~dp0public\CabinetMapper.apk"
if "%APK%"=="" (
  echo  CabinetMapper.apk was not found next to this file or in the folder public.
  pause
  exit /b 1
)

rem adb: on the PATH, or in platform-tools next to this file; otherwise it is downloaded from Google (about 7 MB)
set "ADB="
where adb >nul 2>nul && set "ADB=adb"
if "%ADB%"=="" if exist "%~dp0platform-tools\adb.exe" (
  set "ADB=adb"
  set "PATH=%~dp0platform-tools;%PATH%"
)
if "%ADB%"=="" (
  echo  The Android tool adb is needed. It is free, from Google.
  choice /c YN /m " Download it now into this folder"
  if errorlevel 2 (
    echo  Without it: copy CabinetMapper.apk to the phone and open it there,
    echo  or open http://THIS-PC-ADDRESS:8080/install on the phone.
    pause
    exit /b 1
  )
  echo  Downloading the Android platform tools...
  curl -L -o "%TEMP%\platform-tools.zip" "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
  if errorlevel 1 ( echo  The download failed. Check the internet connection. & pause & exit /b 1 )
  tar -xf "%TEMP%\platform-tools.zip" -C "%~dp0"
  del "%TEMP%\platform-tools.zip" >nul 2>nul
  if not exist "%~dp0platform-tools\adb.exe" ( echo  adb could not be unpacked. & pause & exit /b 1 )
  set "ADB=adb"
  set "PATH=%~dp0platform-tools;%PATH%"
)

echo.
echo  1. Connect the phone with a USB cable ^(a data cable, not a charge-only one^).
echo  2. On the phone, allow "USB debugging" for this computer when it asks.
echo.
adb start-server >nul 2>nul
:wait
set "STATE="
for /f "skip=1 tokens=2" %%s in ('adb devices') do set "STATE=%%s"
if "%STATE%"=="device" goto found
if "%STATE%"=="unauthorized" (
  echo  The phone has not allowed this computer yet: unlock it and press Allow.
) else (
  echo  Waiting for the phone...
)
timeout /t 3 /nobreak >nul
goto wait

:found
for /f "delims=" %%m in ('adb shell getprop ro.product.model') do set "MODEL=%%m"
echo  Phone found: %MODEL%
echo  Installing %APK% ...
adb install -r "%APK%" > "%TEMP%\cm-install.txt" 2>&1
type "%TEMP%\cm-install.txt"
findstr /c:"Success" "%TEMP%\cm-install.txt" >nul
if not errorlevel 1 goto ok

findstr /c:"INSTALL_FAILED_UPDATE_INCOMPATIBLE" /c:"INSTALL_FAILED_VERSION_DOWNGRADE" "%TEMP%\cm-install.txt" >nul
if errorlevel 1 (
  echo.
  echo  The install failed. If the phone shows a message ^(Play Protect, unknown app^), accept it and run this file again.
  pause
  exit /b 1
)
echo.
echo  The app on the phone cannot be updated in place ^(it was signed differently, or it is newer^).
echo  It can be removed and installed again. The copy of the cabinets kept on the phone is then lost;
echo  it comes back the next time the phone connects to the server.
choice /c YN /m " Remove the old app and install this one"
if errorlevel 2 exit /b 1
adb uninstall com.cabinetmapper.field
adb install "%APK%" > "%TEMP%\cm-install.txt" 2>&1
type "%TEMP%\cm-install.txt"
findstr /c:"Success" "%TEMP%\cm-install.txt" >nul
if errorlevel 1 ( echo  The install failed. & pause & exit /b 1 )

:ok
for /f "tokens=2 delims==" %%v in ('adb shell dumpsys package com.cabinetmapper.field ^| findstr /c:"versionName"') do set "VER=%%v"
echo.
echo  Cabinet Mapper %VER% is installed on %MODEL%.
adb shell monkey -p com.cabinetmapper.field -c android.intent.category.LAUNCHER 1 >nul 2>nul
echo  The app was opened on the phone. Give it the address of the server ^(shown by start-server.bat^).
del "%TEMP%\cm-install.txt" >nul 2>nul
pause
