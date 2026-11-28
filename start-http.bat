@echo off
rem chcp 65001: console display codepage for node's UTF-8 output (router logs).
rem NOTE: this file must stay pure ASCII - cmd re-reads the batch file after chcp
rem with a shifted byte offset, which corrupts any non-ASCII text below.
chcp 65001 >nul
rem ================================================================
rem  mcp-router HTTP server launcher (LAN access)
rem  - listens on 0.0.0.0:7800, reachable at http://<your-ip>:7800/mcp
rem  - token check is REQUIRED: this launcher binds 0.0.0.0 (LAN access),
rem    so set MCP_ROUTER_TOKEN before running (or invoke node directly with a config that sets http.authToken).
rem  - health probe: http://127.0.0.1:7800/healthz
rem ================================================================
rem pushd instead of "cd /d": also supports UNC paths (auto-maps a temp drive)
pushd "%~dp0" 2>nul
if errorlevel 1 (
    echo [mcp-router] ERROR: cannot enter the script directory.
    pause
    exit /b 1
)

rem ---- friendly pre-flight checks (common first-run failures) ----
where node >nul 2>&1
if errorlevel 1 (
    echo [mcp-router] ERROR: Node.js was not found on this system.
    echo [mcp-router]        Install Node.js 20 or newer from https://nodejs.org/, then run this script again.
    pause
    exit /b 1
)
rem clear any stale value inherited from the parent shell before parsing
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 20 (
    echo [mcp-router] ERROR: Node.js 20+ is required, current version:
    node -v
    echo [mcp-router]        Please upgrade from https://nodejs.org/
    pause
    exit /b 1
)
if not exist "dist\index.js" (
    echo [mcp-router] ERROR: dist\index.js not found - build the project first:
    echo         npm install
    echo         npm run build
    pause
    exit /b 1
)
if not exist "mcp-router.config.json" (
    echo [mcp-router] ERROR: mcp-router.config.json not found - copy examples\mcp-router.config.example.json, edit it, then run this script again.
    pause
    exit /b 1
)
if not defined MCP_ROUTER_TOKEN (
    echo [mcp-router] ERROR: MCP_ROUTER_TOKEN is not set.
    echo [mcp-router]        This launcher binds 0.0.0.0 (LAN access), so a token is required.
    echo [mcp-router]        Set it first, e.g.:  set MCP_ROUTER_TOKEN=your-secret
    echo [mcp-router]        Or run a loopback-only server with:
    echo [mcp-router]        node dist\index.js --transport http --host 127.0.0.1 --config mcp-router.config.json
    pause
    exit /b 1
)

node dist\index.js --transport http --host 0.0.0.0 --port 7800 --config mcp-router.config.json --auth-token "%MCP_ROUTER_TOKEN%"

echo.
echo [mcp-router] server exited.
pause
