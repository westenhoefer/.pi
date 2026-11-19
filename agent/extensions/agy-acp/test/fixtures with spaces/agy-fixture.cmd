@echo off
setlocal
if not "%~1"=="acp" exit /b 81
if not "%~2"=="--stdio" exit /b 82
if not "%~3"=="" exit /b 83
node "%~dp0acp-fixture.mjs"
