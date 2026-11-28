#!/bin/sh
# mcp-router HTTP server launcher (LAN access); Windows equivalent: start-http.bat
# - listens on 0.0.0.0:7800, reachable at http://<your-ip>:7800/mcp
# - token check is REQUIRED: this launcher binds 0.0.0.0 (LAN access),
#   so set MCP_ROUTER_TOKEN before running (or invoke node directly with a config that sets http.authToken).
# - health probe: http://127.0.0.1:7800/healthz
cd -P "$(dirname "$0")" || exit 1

# ---- friendly pre-flight checks (common first-run failures) ----
if ! command -v node >/dev/null 2>&1; then
    echo "[mcp-router] ERROR: Node.js was not found on this system." >&2
    echo "[mcp-router]        Install Node.js 20 or newer from https://nodejs.org/, then run this script again." >&2
    exit 1
fi
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[mcp-router] ERROR: Node.js 20+ is required, current version: $(node -v 2>/dev/null || echo unknown)." >&2
    echo "[mcp-router]        Please upgrade from https://nodejs.org/ and run this script again." >&2
    exit 1
fi
if [ ! -f dist/index.js ]; then
    echo "[mcp-router] ERROR: dist/index.js not found - build the project first:" >&2
    echo "        npm install" >&2
    echo "        npm run build" >&2
    exit 1
fi
if [ ! -f mcp-router.config.json ]; then
    echo "[mcp-router] ERROR: mcp-router.config.json not found - copy examples/mcp-router.config.example.json, edit it, then run this script again." >&2
    exit 1
fi
if [ -z "${MCP_ROUTER_TOKEN:-}" ]; then
    echo "[mcp-router] ERROR: MCP_ROUTER_TOKEN is not set." >&2
    echo "[mcp-router]        This launcher binds 0.0.0.0 (LAN access), so a token is required." >&2
    echo "[mcp-router]        Set it first, e.g.:  export MCP_ROUTER_TOKEN=your-secret" >&2
    echo "[mcp-router]        Or run a loopback-only server with:" >&2
    echo "[mcp-router]        node dist/index.js --transport http --host 127.0.0.1 --config mcp-router.config.json" >&2
    exit 1
fi

node dist/index.js --transport http --host 0.0.0.0 --port 7800 --config mcp-router.config.json --auth-token "$MCP_ROUTER_TOKEN"
status=$?

echo
echo "[mcp-router] server exited with status $status"
