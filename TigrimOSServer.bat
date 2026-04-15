@echo off
title TigrimOS Server

:: Wait until port 3001 is free (up to 10 seconds)
set WAIT=0
:wait_free
wsl -d TigrimOS -u root -- bash -c "ss -tlnp 2>/dev/null | grep -q ':3001' && exit 1 || exit 0" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :start_server
set /a WAIT+=1
if %WAIT% geq 10 (
    echo   [WARNING] Port 3001 still in use after 10s. Forcing kill...
    wsl -d TigrimOS -u root -- bash -c "pkill -9 -f 'node.*server' 2>/dev/null; pkill -9 -f 'tsx.*index' 2>/dev/null; true" >nul 2>&1
    timeout /t 2 /nobreak >nul
    goto :start_server
)
timeout /t 1 /nobreak >nul
goto :wait_free

:start_server
wsl -d TigrimOS -u root -- bash -c "cd /opt/TigrimOS/tiger_cowork && NODE_ENV=production PORT=3001 node_modules/.bin/tsx server/index.ts >> /tmp/tigrimos.log 2>&1"
