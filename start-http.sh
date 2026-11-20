#!/bin/sh
# mcp-router HTTP 服务启动脚本(局域网访问);Windows 等价物为 start-http.bat
# - 监听 0.0.0.0:7800,局域网内其他机器可通过 http://<本机IP>:7800/mcp 调用
# - 默认不校验 token;如需开启,在下方 node 命令追加 --auth-token <你的密钥>
#   (建议改用配置文件 http.authToken 支持 ${ENV} 环境变量,密钥不落盘)
# - 健康探活: http://127.0.0.1:7800/healthz
cd -P "$(dirname "$0")" || exit 1

node dist/index.js --transport http --host 0.0.0.0 --port 7800 --config mcp-router.config.json

echo
echo "[mcp-router] server exited with status $?"
