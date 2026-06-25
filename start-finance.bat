@echo off
rem Launch from wherever this script lives — no hardcoded path.
cd /d "%~dp0"
node --experimental-sqlite server.js > finance-server-win.log 2>&1
