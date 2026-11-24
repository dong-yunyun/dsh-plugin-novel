@echo off
rem Gate CLI wrapper. Usage: np.cmd verify|publish|status|rollback|gate:selftest [args...]
rem Finds node on PATH first, otherwise falls back to the bundled DSH runtime.
setlocal
chcp 65001 >nul 2>nul

rem Must capture before SHIFT: %0 moves too, and %~dp0 would become the cwd.
set "HERE=%~dp0"

set "NAME=%~1"
if "%NAME%"=="" goto usage
shift

rem status is a mode of publish, not a standalone script
set "PREFIX="
set "SCRIPT=%NAME%"
if /i "%NAME%"=="status" set "SCRIPT=publish"
if /i "%NAME%"=="status" set "PREFIX=--status "
if /i "%NAME%"=="gate:selftest" set "SCRIPT=selftest-gate"

if not exist "%HERE%%SCRIPT%.mjs" goto unknown

set "ARGS="
:collect
if "%~1"=="" goto run
set ARGS=%ARGS% "%~1"
shift
goto collect

:run
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" goto nonode
"%NODE%" "%HERE%%SCRIPT%.mjs" %PREFIX%%ARGS%
exit /b %ERRORLEVEL%

:usage
echo usage: np.cmd [verify^|publish^|status^|rollback^|gate:selftest] [args...]
exit /b 2

:unknown
echo unknown command: %NAME%
exit /b 2

:nonode
echo node not found: put Node.js on PATH or check the DSH runtime
exit /b 2

