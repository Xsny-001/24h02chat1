#!/usr/bin/env node
/**
 * 一键启动脚本：自动挑选可用端口并拉起服务。
 * 用法：node start.js          默认从 3000 开始找
 *       node start.js 8080     指定起始端口
 */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const START = Number(process.argv[2] || process.env.PORT || 3000);
const MAX_TRY = 30;

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function pick() {
  for (let p = START; p < START + MAX_TRY; p++) {
    if (await isFree(p)) return p;
  }
  return null;
}

(async () => {
  const port = await pick();
  if (!port) {
    console.error(`端口 ${START} ~ ${START + MAX_TRY - 1} 全部被占用，请手动指定：node start.js 9000`);
    process.exit(1);
  }
  if (port !== START) {
    console.log(`端口 ${START} 已被占用，改用 ${port}`);
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
})();
