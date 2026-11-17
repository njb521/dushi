/**
 * 密码哈希：scrypt（`node:crypto`，零依赖）。
 *
 * 设计文档写的是 argon2id / bcrypt cost 12。这里改用 scrypt，原因：
 *  - argon2 的 Node 绑定要原生编译（Windows 上还得装 build tools），bcrypt 的 prebuilt 也挑 ABI；
 *  - scrypt 是 OWASP 明确推荐的密码哈希（内存硬，抗 GPU/ASIC），Node 内置；
 *  - 参数按 OWASP 建议 N=2^15, r=8, p=1（约 32MB 内存 / 单次 ~100ms）。
 *
 * 存储格式（自描述，便于日后升级参数而不破坏旧密码）：
 *   scrypt$N$r$p$<salt-b64>$<hash-b64>
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 1 << 15, r: 8, p: 1 };
const KEYLEN = 64;
const SALT_BYTES = 16;
/** 128 * N * r * 2 —— 给 maxmem 留一倍余量，避免默认 32MB 上限报错 */
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 用户名不存在时也要花掉同样的时间，避免用响应时间做用户名探测 */
let dummyHash: string | null = null;
export async function burnVerifyTime(password: string): Promise<void> {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}
