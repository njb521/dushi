/**
 * 会话：签发 / 校验 / cookie 读写。
 *
 * 两个安全细节值得说明：
 *  1. **密钥持久化**：不把密钥写死在代码里，也不每次启动随机生成（那会让所有已登录用户
 *     在重启后集体掉线）。优先 DUSHI_JWT_SECRET，否则落盘到 data/jwt.key（首次自动生成）。
 *  2. **Secure 自适应**：局域网是 http://192.168.x.x，无条件加 Secure 会让浏览器直接丢 cookie，
 *     表现为"登录成功但还是未登录"。所以只有请求确实是 https（或反代声明 X-Forwarded-Proto）
 *     时才加 Secure。公网部署（M6）走 HTTPS 后自动生效。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR, findUserById } from '../db.ts';
import type { SessionPayload } from './jwt.ts';
import { signJwt, verifyJwt } from './jwt.ts';

export const COOKIE_NAME = 'dushi_session';
/** 7 天 */
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

let cachedSecret: string | null = null;

export function sessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.DUSHI_JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  const file = join(DATA_DIR, 'jwt.key');
  if (existsSync(file)) {
    cachedSecret = readFileSync(file, 'utf8').trim();
  } else {
    mkdirSync(DATA_DIR, { recursive: true });
    const secret = randomBytes(32).toString('hex');
    writeFileSync(file, secret, { mode: 0o600 });
    cachedSecret = secret;
  }
  return cachedSecret;
}

export interface SessionUser {
  id: number;
  username: string;
}

export function issueToken(user: { id: number; username: string; token_version: number }): string {
  return signJwt({ sub: user.id, name: user.username, ver: user.token_version }, sessionSecret(), SESSION_TTL_SEC);
}

/**
 * 校验 token 并落地成用户：JWT 只证明"是我签的"，还要回库确认用户还在、
 * 且 token_version 没变（改密码后旧 token 立刻失效）。
 */
export function resolveSession(token: string | null | undefined): SessionUser | null {
  const payload: SessionPayload | null = verifyJwt(token, sessionSecret());
  if (!payload) return null;
  const user = findUserById(payload.sub);
  if (!user || user.token_version !== payload.ver) return null;
  return { id: user.id, username: user.username };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isHttps(req: IncomingMessage): boolean {
  const socket = req.socket as { encrypted?: boolean };
  if (socket?.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return typeof first === 'string' && first.split(',')[0].trim() === 'https';
}

export function sessionCookie(token: string, secure: boolean): string {
  const bits = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(secure: boolean): string {
  const bits = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** 从 HTTP 请求里取当前用户（未登录返回 null） */
export function userFromRequest(req: IncomingMessage): SessionUser | null {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return resolveSession(token);
}
