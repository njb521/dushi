/**
 * 账号层单测：密码哈希 / JWT / 限流 / 生涯分累加。
 *
 * 数据库用临时目录隔离（必须在 import db.ts 之前设 DUSHI_DATA_DIR），
 * 所以这里用动态 import 而不是顶部的静态 import。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import '../src/quiet.ts';

process.env.DUSHI_DATA_DIR = join(tmpdir(), `dushi-test-${process.pid}-${Date.now()}`);
const db = await import('../src/db.ts');
const { hashPassword, verifyPassword } = await import('../src/auth/password.ts');
const { signJwt, verifyJwt } = await import('../src/auth/jwt.ts');
const { RateLimiter } = await import('../src/auth/limiter.ts');
const { parseCookies, sessionCookie, clearCookie } = await import('../src/auth/session.ts');

const SECRET = 'test-secret-0123456789abcdef';

// ── 密码 ────────────────────────────────────────────────

test('密码哈希：正确密码通过，错误密码拒绝，且每次盐不同', async () => {
  const a = await hashPassword('abcd1234');
  const b = await hashPassword('abcd1234');
  assert.notEqual(a, b, '相同密码两次哈希必须不同（随机盐）');
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(await verifyPassword('abcd1234', a), true);
  assert.equal(await verifyPassword('abcd12345', a), false);
  assert.equal(await verifyPassword('', a), false);
});

test('密码哈希：损坏的存储串一律拒绝，不抛错', async () => {
  for (const bad of ['', 'plaintext', 'scrypt$x$y$z$a$b', 'scrypt$16384$8$1$$', 'md5$1$2$3$abc$def']) {
    assert.equal(await verifyPassword('abcd1234', bad), false, `应拒绝 ${bad}`);
  }
});

test('密码哈希：中文/emoji 密码按 NFKC 归一后可用', async () => {
  const h = await hashPassword('密码密码🐾');
  assert.equal(await verifyPassword('密码密码🐾', h), true);
});

// ── JWT ─────────────────────────────────────────────────

test('JWT：签发后可校验，字段原样返回', () => {
  const t = signJwt({ sub: 7, name: '阿良', ver: 0 }, SECRET, 3600);
  const p = verifyJwt(t, SECRET);
  assert.ok(p);
  assert.equal(p.sub, 7);
  assert.equal(p.name, '阿良');
  assert.equal(p.ver, 0);
  assert.ok(p.exp > p.iat);
});

test('JWT：过期即失效', () => {
  const t = signJwt({ sub: 1, name: 'a', ver: 0 }, SECRET, 60, Date.now() - 120_000);
  assert.equal(verifyJwt(t, SECRET), null);
});

test('JWT：篡改 payload 或换密钥都过不了', () => {
  const t = signJwt({ sub: 1, name: 'a', ver: 0 }, SECRET, 3600);
  const [h, , s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 999, name: 'hacker', ver: 0, iat: 1, exp: 2_000_000_000 })).toString(
    'base64url',
  );
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, SECRET), null);
  assert.equal(verifyJwt(t, 'another-secret-xxxxxxxx'), null);
});

test('JWT：拒绝 alg=none 与结构错误的 token', () => {
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 1, name: 'a', ver: 0, iat: 1, exp: 2_000_000_000 })).toString(
    'base64url',
  );
  assert.equal(verifyJwt(`${none}.${body}.`, SECRET), null);
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token']) {
    assert.equal(verifyJwt(bad, SECRET), null, `应拒绝 ${bad}`);
  }
});

// ── 限流 ────────────────────────────────────────────────

test('限流：5 次后封禁，窗口过后自动放开，reset 立即清零', () => {
  const rl = new RateLimiter(5, 60_000);
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.blocked('ip', now).blocked, false, `第 ${i + 1} 次不应被封`);
    rl.hit('ip', now);
  }
  const blocked = rl.blocked('ip', now);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterMs > 0);

  assert.equal(rl.blocked('other-ip', now).blocked, false, '限流按 key 隔离');
  assert.equal(rl.blocked('ip', now + 61_000).blocked, false, '窗口过后应放开');

  rl.hit('ip2', now);
  rl.reset('ip2');
  assert.equal(rl.blocked('ip2', now).blocked, false);
});

// ── cookie ──────────────────────────────────────────────

test('cookie：http 不加 Secure，https 才加；解析多个键不互相污染', () => {
  assert.ok(!sessionCookie('tok', false).includes('Secure'));
  assert.ok(sessionCookie('tok', true).includes('Secure'));
  assert.ok(sessionCookie('tok', true).includes('HttpOnly'));
  assert.ok(sessionCookie('tok', true).includes('SameSite=Lax'));
  assert.ok(clearCookie(true).includes('Max-Age=0'));

  const jar = parseCookies('a=1; dushi_session=xyz.abc.def; b=2');
  assert.equal(jar.dushi_session, 'xyz.abc.def');
  assert.equal(jar.a, '1');
  assert.equal(jar.b, '2');
});

// ── 数据层 ──────────────────────────────────────────────

test('建号：同名（含大小写差异）不能重复注册', () => {
  const u = db.createUser('player_one', 'hash');
  assert.ok(u);
  assert.equal(u.username, 'player_one');
  assert.equal(db.createUser('player_one', 'hash2'), null);
  assert.equal(db.createUser('PLAYER_ONE', 'hash2'), null, '大小写视为同一个用户名');
  assert.equal(db.findUserByName('Player_One')?.id, u.id);
});

test('生涯分：多局累加，胜负/独食计数正确，零和不变', () => {
  const u = db.createUser('scorer', 'hash');
  assert.ok(u);
  const m = db.createMatch('123456', '{}', 42);

  db.recordRound([
    { matchId: m, roundNo: 1, userId: u.id, seat: 0, place: 1, isSolo: false, declared: null, delta: 6 },
  ]);
  db.recordRound([
    { matchId: m, roundNo: 2, userId: u.id, seat: 0, place: 2, isSolo: true, declared: 'none', delta: -3 },
  ]);

  const s = db.getStats(u.id);
  assert.equal(s.total_score, 3);
  assert.equal(s.games, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.solo_games, 1);
  assert.equal(s.solo_wins, 0);

  const hist = db.recentRounds(u.id, 10);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].delta, -3, '最近一局排在前面');
  assert.equal(hist[0].is_solo, 1);
});

test('排行榜：只统计打过牌的人，按生涯分降序', () => {
  const a = db.createUser('board_a', 'h');
  const b = db.createUser('board_b', 'h');
  assert.ok(a && b);
  const m = db.createMatch('999999', '{}', 7);
  db.recordRound([{ matchId: m, roundNo: 1, userId: a.id, seat: 0, place: 1, isSolo: false, declared: null, delta: 2 }]);
  db.recordRound([{ matchId: m, roundNo: 1, userId: b.id, seat: 1, place: 2, isSolo: false, declared: null, delta: -2 }]);

  const rows = db.leaderboard(50);
  const ia = rows.findIndex((r) => r.username === 'board_a');
  const ib = rows.findIndex((r) => r.username === 'board_b');
  assert.ok(ia >= 0 && ib >= 0);
  assert.ok(ia < ib, '分高的排前面');
});

test('改密码：token_version 自增（旧 token 因此失效）', () => {
  const u = db.createUser('rotate_me', 'h');
  assert.ok(u);
  const before = u.token_version;
  db.updatePassword(u.id, 'newhash');
  const after = db.findUserById(u.id)!;
  assert.equal(after.token_version, before + 1);
  assert.equal(after.pass_hash, 'newhash');
});

test('cleanup', () => {
  db.closeDb();
});
