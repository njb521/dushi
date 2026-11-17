/**
 * 单端口服务：同一路由上提供 WebSocket（含 /matchmake）+ web 静态文件。
 *
 *   node packages/server/src/index.ts   →  http://0.0.0.0:3000
 *   朋友在同一 WiFi 打开 http://<你的局域网IP>:3000 即可
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
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
    if (!existsSync(WEB_DIST)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>独食服务已启动</h1><p>但还没构建前端。运行：<code>npm run build</code> 后刷新本页面。</p>',
      );
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
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

// joinOrCreate 按 options（即房号）深比较匹配房间；首个进房者建房，其余加入同房
gameServer.define('dushi', DushiRoom);

gameServer.listen({ port: PORT });

console.log(`🂡 独食服务器已启动：http://localhost:${PORT}`);
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
