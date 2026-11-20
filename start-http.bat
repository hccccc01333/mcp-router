@echo off
rem chcp 65001: console display codepage for node's UTF-8 output (router logs).
rem NOTE: this file must stay pure ASCII - cmd re-reads the batch file after chcp
rem with a shifted byte offset, which corrupts any non-ASCII text below.
chcp 65001 >nul
rem ================================================================
rem  mcp-router HTTP server launcher (LAN access)
rem  - listens on 0.0.0.0:7800, reachable at http://<your-ip>:7800/mcp
rem  - token check is OFF by default; add --auth-token <secret> to enable
rem    (prefer config file http.authToken with ${ENV} expansion)
rem  - health probe: http://127.0.0.1:7800/healthz
rem ================================================================
cd /d "%~dp0"

node dist\index.js --transport http --host 0.0.0.0 --port 7800 --config mcp-router.config.json

echo.
echo [mcp-router] server exited.
pause
