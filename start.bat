@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:8090
node server.mjs %*
