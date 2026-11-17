/**
 * 极简 JWT（HS256）—— 只实现本项目需要的签发/校验，零依赖。
 *
 * 之所以不装 jsonwebtoken：我们需要的就是"HMAC 一个 JSON"，多一个依赖就多一处
 * 供应链面和一次 Windows 安装摩擦。这里显式做三件事：
 *   1. 只接受 alg=HS256（防 alg=none 降级）
 *   2. 签名用 timingSafeEqual 比较（防时序侧信道）
 *   3. 过期时间由服务端校验，绝不信任 payload 里的任何时间
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** userId */
  sub: number;
  /** 用户名（展示用） */
  name: string;
  /** token 版本号，改密码后自增 → 旧 token 全部失效 */
  ver: number;
  iat: number;
  exp: number;
}

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signJwt(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const body: SessionPayload = { ...payload, iat, exp: iat + ttlSeconds };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  return `${data}.${b64u(hmac(data, secret))}`;
}

export function verifyJwt(token: string | undefined | null, secret: string, nowMs = Date.now()): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;

  const expected = hmac(`${head}.${body}`, secret);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.sub !== 'number' || typeof payload.exp !== 'number') return null;
  if (typeof payload.ver !== 'number') return null;
  if (payload.exp * 1000 <= nowMs) return null;
  return payload;
}
