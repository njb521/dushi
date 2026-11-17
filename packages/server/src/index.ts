/**
 * 单端口服务：同一路由上提供 WebSocket（含 /matchmake）+ /api 账号接口 + web 静态文件。
 *
 *   node packages/server/src/index.ts   →  http://0.0.0.0:3000
 *   朋友在同一 WiFi 打开 http://<你的局域网IP>:3000 即可
 */

import './quiet.ts'; // 必须最先执行：压掉 node:sqlite 的实验性警告
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { handleApi } from './api.ts';
import { DB_FILE, openDb } from './db.ts';
import { sessionSecret } from './auth/session.ts';
import { DushiRoom } from './room.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIST = join(__dirname, '..', '..', 'web', 'dist');
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // 账号接口优先，未命中再走静态文件
    if (await handleApi(req, res)) return;

    if (!existsSync(WEB_DIST)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>独食服务已启动</h1><p>但还没构建前端。运行：<code>npm run build</code> 后刷新本页面。</p>',
      );
      return;
    }
    // 注意：Windows 上 path.normalize('/') 会得到 '\'，所以先做原始比较
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('..')) {
      res.writeHead(400).end('bad path');
      return;
    }
    let file = pathname === '/' ? join(WEB_DIST, 'index.html') : join(WEB_DIST, pathname);
    if (!existsSync(file) && !extname(pathname)) file = join(WEB_DIST, 'index.html'); // SPA fallback
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// 关键：必须 filterBy(['code'])，否则 joinOrCreate 只按房间名匹配 —— 不同房号会全部挤进
// 同一个房间（M1' 单群使用时没暴露，多群同时开局立刻串房）。
gameServer.define('dushi', DushiRoom).filterBy(['code']);

// 账号库与会话密钥：启动即初始化，坏掉要立刻暴露，而不是等第一个玩家登录
openDb();
sessionSecret();

gameServer.listen({ port: PORT });

console.log(`🂡 独食服务器已启动：http://localhost:${PORT}`);
console.log(`   账号库：${DB_FILE}`);
if (existsSync(WEB_DIST)) console.log(`   已挂载前端构建产物：${WEB_DIST}`);

function printLanHint(): void {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  if (ips.length) console.log(`   局域网地址：${ips.map((ip) => `http://${ip}:${PORT}`).join('  ')}`);
}
printLanHint();
