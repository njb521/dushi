/**
 * 账号相关 HTTP 接口（挂在前端同一端口的 /api/* 下）。
 *
 *   POST /api/register   { username, password }        → 201 { user, stats }
 *   POST /api/login      { username, password }        → 200 { user, stats }
 *   POST /api/logout                                   → 204
 *   GET  /api/me                                       → 200 { user, stats } | 401
 *   POST /api/password   { oldPassword, newPassword }   → 200 { user, stats }
 *   GET  /api/leaderboard                              → 200 { rows: [...] }
 *   GET  /api/history                                  → 200 { rows: [...] }
 *
 * 约定：所有错误都是 `{ error: "中文人话" }`，客户端直接显示。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createUser,
  findUserByName,
  getStats,
  leaderboard,
  rankOf,
  recentRounds,
  summaryOf,
  touchLogin,
  updatePassword,
  usernameTaken,
} from './db.ts';
import { burnVerifyTime, hashPassword, verifyPassword } from './auth/password.ts';
import { checkLimiter, loginLimiter, registerLimiter } from './auth/limiter.ts';
import {
  clearCookie,
  isHttps,
  issueToken,
  sessionCookie,
  userFromRequest,
} from './auth/session.ts';
import type { SessionUser } from './auth/session.ts';

const MAX_BODY = 4096;

/** 用户名：2–16 个字符，只允许文字/数字/下划线/连字符（中文名两个字也能用） */
const USERNAME_RE = /^[\p{L}\p{N}_-]{2,16}$/u;

export interface PublicUser {
  id: number;
  username: string;
}
export interface PublicStats {
  totalScore: number;
  games: number;
  wins: number;
  soloGames: number;
  soloWins: number;
  bestStreak: number;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, msg: string, headers: Record<string, string> = {}): void {
  json(res, status, { error: msg }, headers);
}

/** 语义化失败返回：接口函数都是 'return true 表示已处理' */
function bad(res: ServerResponse, msg: string, status = 400): true {
  fail(res, status, msg);
  return true;
}

function badBody(res: ServerResponse): true {
  return bad(res, '请求格式错误');
}

function clientIp(req: IncomingMessage): string {
  // 直连时用对端地址；M6 挂 frp 后全部变成 127.0.0.1，需要打开显式信任开关才读反代头
  if (process.env.DUSHI_TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    const first = Array.isArray(xff) ? xff[0] : xff;
    if (typeof first === 'string' && first.trim()) return first.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) return null;
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function validateUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return USERNAME_RE.test(name) ? name : null;
}

function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const pw = raw.normalize('NFKC');
  if (pw.length < 6 || pw.length > 128) return null;
  return pw;
}

function statsOf(userId: number): PublicStats {
  const s = getStats(userId);
  return {
    totalScore: s.total_score,
    games: s.games,
    wins: s.wins,
    soloGames: s.solo_games,
    soloWins: s.solo_wins,
    bestStreak: s.best_streak,
  };
}

function authPayload(user: PublicUser): { user: PublicUser; stats: PublicStats } {
  return { user, stats: statsOf(user.id) };
}

function requireUser(req: IncomingMessage, res: ServerResponse): SessionUser | null {
  const user = userFromRequest(req);
  if (!user) fail(res, 401, '请先登录');
  return user;
}

// ── 处理入口 ────────────────────────────────────────────

/** 返回 true 表示已处理（调用方不要再走静态文件） */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!path.startsWith('/api/')) return false;

  const method = (req.method ?? 'GET').toUpperCase();
  const route = `${method} ${path}`;

  try {
    switch (route) {
      case 'POST /api/register':
        return await register(req, res);
      case 'GET /api/username-available':
        return checkUsername(req, res);
      case 'POST /api/login':
        return await login(req, res);
      case 'POST /api/logout':
        return logout(req, res);
      case 'GET /api/me':
        return me(req, res);
      case 'POST /api/password':
        return await changePassword(req, res);
      case 'GET /api/leaderboard':
        return board(req, res);
      case 'GET /api/stats/summary':
        return statsSummary(req, res);
      case 'GET /api/history':
        return history(req, res);
      default:
        fail(res, 404, '接口不存在');
        return true;
    }
  } catch (e) {
    console.error('[api]', route, e);
    if (!res.headersSent) fail(res, 500, '服务器出错了，稍后再试');
    else res.end();
    return true;
  }
}

// ── 各接口 ──────────────────────────────────────────────

/**
 * 注册页的"这个用户名能用吗"。
 *
 * 只回答「格式对不对 / 有没有被占」，不做任何登录态要求 —— 它就是个输入框提示。
 * 真正防重复的仍是 createUser 的唯一约束：这里说 available，提交时被别人抢先注册，
 * 照样会在 register 里拿到 409。所以这个接口只是体验优化，不是安全边界。
 */
function checkUsername(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = clientIp(req);
  const limit = checkLimiter.blocked(`check:${ip}`);
  if (limit.blocked) {
    fail(res, 429, '查得太快了，歇一下再输入', {
      'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
    });
    return true;
  }
  checkLimiter.hit(`check:${ip}`);

  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
  const username = validateUsername(raw);
  if (!username) {
    json(res, 200, { available: false, reason: 'invalid', error: '用户名 2–16 个字符，可用中英文、数字、下划线' });
    return true;
  }
  if (usernameTaken(username)) {
    json(res, 200, { available: false, reason: 'taken', error: '这个用户名已经被占用了，换一个吧' });
    return true;
  }
  json(res, 200, { available: true });
  return true;
}

async function register(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const ip = clientIp(req);
  const reg = registerLimiter.blocked(`reg:${ip}`);
  if (reg.blocked) {
    fail(res, 429, '注册太频繁了，过一会儿再试', { 'retry-after': String(Math.ceil(reg.retryAfterMs / 1000)) });
    return true;
  }
  registerLimiter.hit(`reg:${ip}`);

  const body = await readJson(req);
  if (!body) return badBody(res);

  const username = validateUsername(body.username);
  if (!username) return bad(res, '用户名 2–16 个字符，可用中英文、数字、下划线');

  const password = validatePassword(body.password);
  if (!password) return bad(res, '密码至少 6 位');

  const hash = await hashPassword(password);
  const user = createUser(username, hash);
  if (!user) return bad(res, '这个用户名已经被占用了', 409);

  touchLogin(user.id);
  const token = issueToken(user);
  json(
    res,
    201,
    authPayload({ id: user.id, username: user.username }),
    { 'set-cookie': sessionCookie(token, isHttps(req)) },
  );
  return true;
}

async function login(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const ip = clientIp(req);
  const key = `login:${ip}`;
  const limit = loginLimiter.blocked(key);
  if (limit.blocked) {
    fail(res, 429, `密码错误次数太多，${Math.ceil(limit.retryAfterMs / 1000)} 秒后再试`, {
      'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
    });
    return true;
  }

  const body = await readJson(req);
  if (!body) return badBody(res);

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password.normalize('NFKC') : '';
  if (!username || !password) return bad(res, '请输入用户名和密码');

  const user = findUserByName(username);
  const ok = user ? await verifyPassword(password, user.pass_hash) : (await burnVerifyTime(password), false);
  if (!user || !ok) {
    loginLimiter.hit(key);
    // 不区分"用户不存在"和"密码错误"，避免探测用户名
    return bad(res, '用户名或密码不对', 401);
  }

  loginLimiter.reset(key);
  touchLogin(user.id);
  const token = issueToken(user);
  json(
    res,
    200,
    authPayload({ id: user.id, username: user.username }),
    { 'set-cookie': sessionCookie(token, isHttps(req)) },
  );
  return true;
}

function logout(req: IncomingMessage, res: ServerResponse): boolean {
  res.writeHead(204, { 'set-cookie': clearCookie(isHttps(req)), 'cache-control': 'no-store' });
  res.end();
  return true;
}

function me(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireUser(req, res);
  if (!user) return true;
  json(res, 200, authPayload(user));
  return true;
}

async function changePassword(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const user = requireUser(req, res);
  if (!user) return true;

  const body = await readJson(req);
  if (!body) return badBody(res);

  const oldPw = typeof body.oldPassword === 'string' ? body.oldPassword.normalize('NFKC') : '';
  const newPw = validatePassword(body.newPassword);
  if (!newPw) return bad(res, '新密码至少 6 位');

  const row = findUserByName(user.username);
  if (!row || !(await verifyPassword(oldPw, row.pass_hash))) return bad(res, '原密码不对', 403);

  updatePassword(row.id, await hashPassword(newPw));
  // token_version 已自增 → 旧 token 全部失效，这里给当前设备补发一个新的
  const fresh = findUserByName(user.username);
  if (!fresh) return bad(res, '服务器出错了', 500);
  const token = issueToken(fresh);
  json(res, 200, authPayload({ id: fresh.id, username: fresh.username }), {
    'set-cookie': sessionCookie(token, isHttps(req)),
  });
  return true;
}

function board(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireUser(req, res);
  if (!user) return true;
  const stats = getStats(user.id);
  json(res, 200, {
    rows: leaderboard(20),
    // 没进前 20 也能看到自己排第几
    me: {
      rank: rankOf(user.id),
      username: user.username,
      totalScore: stats.total_score,
      games: stats.games,
      wins: stats.wins,
    },
  });
  return true;
}

/** 战绩页顶部概览：胜率、最高单局、最近 7 天走势 */
function statsSummary(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireUser(req, res);
  if (!user) return true;
  json(res, 200, summaryOf(user.id));
  return true;
}

/** 最近对局：游标分页（before = 上一页最后一条的 id） */
function history(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireUser(req, res);
  if (!user) return true;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.round(limitRaw))) : 20;
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw !== null && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : undefined;

  const rows = recentRounds(user.id, limit, before);
  json(res, 200, {
    rows,
    // 拿满一页才可能有下一页；否则前端不必再请求
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
  });
  return true;
}
