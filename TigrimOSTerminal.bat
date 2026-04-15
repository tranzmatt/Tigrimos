@echo off
:: TigrimOS - Open Terminal into Ubuntu WSL2 sandbox
title TigrimOS Terminal

echo.
echo   ========================================
echo      TigrimOS - Terminal
echo   ========================================
echo.

:: Check WSL is available
wsl --status >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] WSL2 is not installed or not enabled.
    echo   Please run TigrimOSInstaller.bat first.
    echo.
    pause
    exit /b 1
)

:: Check if TigrimOS distro exists
wsl -d TigrimOS -- echo ok >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] TigrimOS WSL distribution not found.
    echo   Please run TigrimOSInstaller.bat first.
    echo.
    pause
    exit /b 1
)

:: Open terminal into TigrimOS WSL2
echo   Connecting to TigrimOS...
echo.
wsl -d TigrimOS
