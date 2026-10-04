#!/bin/bash
# 重置数据并生成截图：确保服务在空库状态下启动
set -e
cd "$(dirname "$0")"

echo "[1/4] 停止现有服务…"
PID=$(ss -lptnH 'sport = :3000' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$PID" ]; then kill -9 "$PID" 2>/dev/null || true; fi
sleep 2

echo "[2/4] 清空数据库与上传…"
rm -f data/store.json
rm -rf data/uploads
rm -f screenshots/*.png
mkdir -p screenshots

echo "[3/4] 启动服务…"
setsid nohup node server.js > /tmp/shots-server.log 2>&1 < /dev/null &
sleep 3
curl -s http://localhost:3000/api/health
echo ""

echo "[4/4] 生成截图…"
NODE_PATH=/root/.nvm/versions/node/v22.13.1/lib/node_modules node shots.js
echo "完成，产物："
ls screenshots/
