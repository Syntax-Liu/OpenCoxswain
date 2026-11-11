@echo off
rem 一键出包：双击本文件即可。
rem 所有实际逻辑在 build-app.ps1 里，这里只负责用正确的执行策略调用它。
chcp 65001 >nul
title OpenCoxswain 打包
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-app.ps1" %*
echo.
pause
