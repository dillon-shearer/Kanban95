@echo off
rem Kanban95 launcher. Double-click: the board opens on this repo. Drop a project folder onto this file (or run
rem `Kanban95.cmd C:\path\to\project`): the board opens on that project. Any folder: a plain one is made a local git repo.
rem Puts Node 24 first on PATH (found through fnm when the Node on PATH is older), builds, then starts the shell.
setlocal
if defined KANBAN95_AGENT (
  echo Kanban95 is already running; verify with npm test, not by starting the app.
  exit /b 1
)
cd /d "%~dp0"
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%~dp0."

node -e "process.exit(process.versions.node.split('.')[0] < 24 ? 1 : 0)" 2>nul && goto run
rem fnm puts Node 24 first on its PATH, so the first `where node` line is it.
for /f "delims=" %%i in ('fnm exec --using=24 where node 2^>nul') do if not defined NODE24 set "NODE24=%%~dpi"
if defined NODE24 set "PATH=%NODE24%;%PATH%"
node -e "process.exit(process.versions.node.split('.')[0] < 24 ? 1 : 0)" 2>nul && goto run
echo Kanban95 needs Node 24 or newer. Install it, for example: fnm install 24
if not defined KANBAN95_HIDDEN pause
exit /b 1

:run
if not exist node_modules (
  call npm install || goto failed
)
call npm run dev -- "%REPO%" || goto failed
exit /b 0

:failed
echo.
echo Kanban95 did not start. The messages above say why.
if not defined KANBAN95_HIDDEN pause
exit /b 1
