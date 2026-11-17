/**
 * 端到端测试：4 个真客户端通过 WebSocket 联机打完一局，并做手牌泄露审计。
 *
 *   npm run e2e
 *
 * 自动拉起测试服务器（端口 3123，可被 DUSHI_E2E_PORT 覆盖；若该端口已有服务则复用）。
 * 数据目录默认用系统临时目录隔离（DUSHI_DATA_DIR 可覆盖），不会污染正式账号库。
 *
 * 客户端只依据视图行事（自己的手牌 + 公开牌面），等价于 4 个真实玩家，
 * 不读取任何服务端内部状态 —— 这本身就是信息最小化的验证。
 *
 * M2 起入房需要登录，所以整条链路也从"注册 4 个账号"开始：注册 → 拿 token → 带 token 进房
 * → 打完一局 → 回查 /api/me 的生涯分是否等于本局 delta。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'colyseus.js';
import { RANK_POWER, SUIT_POWER } from '@dushi/rules';

const NAMES = ['甲', '乙', '丙', '丁'];
const PORT = Number(process.env.DUSHI_E2E_PORT ?? 3123);
const CODE = String(Math.floor(100_000 + Math.random() * 900_000));
const BASE = `http://127.0.0.1:${PORT}`;

interface View {
  phase: 'waiting' | 'playing' | 'declaring' | 'settling';
  you: number;
  turn: number | null;
  declareAsk: boolean;
  yourHand: { s: string; r: string }[] | null;
  trick: { seat: number; cards: { s: string; r: string }[]; cat: string } | null;
  baiPaiHand: { s: string; r: string }[] | null;
  scores: number[];
  careerDelta: number[];
  seats: { seat: number; name: string; career: number | null }[];
  settle: null | { reason: string; deltas: number[]; places: number[] };
  eventLog: string[];
  rulesNote: string;
}

interface Account {
  username: string;
  password: string;
  token: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const label = (c: { s: string; r: string }) => `${c.s}${c.r}`;
const power = (c: { s: string; r: string }) =>
  RANK_POWER[c.r as keyof typeof RANK_POWER] * 10 + SUIT_POWER[c.s as keyof typeof SUIT_POWER];
const smallest = (hand: { s: string; r: string }[]) => [...hand].sort((a, b) => power(a) - power(b))[0];

function powerOfLabel(l: string): number {
  const m = /^([SHCD])(10|[2-9AJQK])$/.exec(l);
  if (!m) throw new Error(`坏牌码 ${l}`);
  return RANK_POWER[m[2] as keyof typeof RANK_POWER] * 10 + SUIT_POWER[m[1] as keyof typeof SUIT_POWER];
}

async function ensureServer(): Promise<(() => void) | null> {
  try {
    await fetch(`${BASE}/`);
    console.log(`复用已在 :${PORT} 的服务`);
    return null;
  } catch {
    /* 未启动 */
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, '..', 'src', 'index.ts')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DUSHI_DATA_DIR: process.env.DUSHI_DATA_DIR ?? join(tmpdir(), `dushi-e2e-${process.pid}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`  [server!] ${d}`));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      await fetch(`${BASE}/`);
      console.log(`测试服务器已启动 :${PORT}`);
      return () => child.kill();
    } catch {
      /* 继续等 */
    }
  }
  child.kill();
  throw new Error('测试服务器启动失败');
}

/** 注册 4 个账号并从 set-cookie 里取 token（等价于浏览器里登录一次） */
async function registerAccounts(): Promise<Account[]> {
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  const password = 'e2e-pass-1234';
  const accounts: Account[] = [];
  for (const base of NAMES) {
    const username = `${base}${suffix}`;
    const res = await fetch(`${BASE}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status !== 201) throw new Error(`注册失败 ${username}: ${res.status} ${await res.text()}`);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('dushi_session='));
    if (!cookie) throw new Error('注册成功但没拿到会话 cookie');
    accounts.push({ username, password, token: cookie.slice('dushi_session='.length) });
  }
  return accounts;
}

async function careerOf(token: string): Promise<{ totalScore: number; games: number; wins: number }> {
  const res = await fetch(`${BASE}/api/me`, { headers: { cookie: `dushi_session=${token}` } });
  if (!res.ok) throw new Error(`/api/me 失败 ${res.status}`);
  const body = (await res.json()) as { stats: { totalScore: number; games: number; wins: number } };
  return body.stats;
}

async function main(): Promise<void> {
  const stop = await ensureServer();
  const client = new Client(`ws://127.0.0.1:${PORT}`);

  // ── 0. 账号链路：注册 → 未登录必须被拒 → 带 token 才能进房 ──
  const accounts = await registerAccounts();
  console.log(`已注册 4 个测试账号：${accounts.map((a) => a.username).join(' ')}`);

  let rejected = false;
  try {
    const ghost = await client.joinOrCreate('dushi', { code: String(Math.floor(100_000 + Math.random() * 900_000)) });
    ghost.leave();
  } catch {
    rejected = true;
  }
  if (!rejected) {
    if (stop) stop();
    console.error('✗ 未登录竟然能进房（鉴权失效）');
    process.exit(1);
  }
  console.log('✓ 未登录进房被拒绝');

  const rooms: any[] = [];
  const latest = new Map<number, View>();
  const leaks: string[] = [];
  // ── 安全审计（信息论基准，不依赖时序）──
  //   A1 一张实体牌全局只有一份 → 不能同时出现在两个座位的 yourHand
  //   A2 已打出的牌不能再出现在任何 yourHand（摆牌公开除外）
  //   A3 yourHand 内不得有重复牌
  //   A4 视图的非牌面字段（排除 rulesNote/eventLog）不得出现牌码
  const handOwner = new Map<string, number>();
  const playedOnce = new Set<string>();
  const publicBaiPai = new Set<string>();
  let viewCount = 0;

  const settledIdx = new Set<number>();
  const resolvers: ((v: View) => void)[] = [];
  const finished: Promise<View>[] = NAMES.map(
    () => new Promise<View>((res) => resolvers.push(res)),
  );

  const audit = (who: number, v: View): void => {
    viewCount++;
    if (v.baiPaiHand) for (const c of v.baiPaiHand) publicBaiPai.add(label(c));
    if (v.trick) for (const c of v.trick.cards) playedOnce.add(label(c));
    if (v.yourHand) {
      const seen = new Set<string>();
      for (const c of v.yourHand) {
        const l = label(c);
        if (seen.has(l)) leaks.push(`座位 ${who}：yourHand 重复牌 ${l}`);
        seen.add(l);
        const owner = handOwner.get(l);
        if (owner !== undefined && owner !== who) {
          leaks.push(`座位 ${who} 手牌含 ${l}，但该牌曾在座位 ${owner} 手中`);
        }
        handOwner.set(l, who);
        if (playedOnce.has(l) && !publicBaiPai.has(l)) {
          leaks.push(`座位 ${who} 手牌含 ${l}，但该牌已被打出`);
        }
      }
    }
    const { yourHand: _h, trick: _t, baiPaiHand: _b, eventLog: _l, rulesNote: _n, ...rest } = v;
    const text = JSON.stringify(rest);
    if (/(?:[♠♥♣♦])(?:10|[2-9AJQK])/.test(text)) {
      leaks.push(`座位 ${who}：非牌面字段出现牌码 → ${text.slice(0, 160)}`);
    }
    if (v.phase === 'settling' && v.settle && !settledIdx.has(who)) {
      settledIdx.add(who);
      resolvers[who](v);
    }
  };

  for (let i = 0; i < NAMES.length; i++) {
    const room = await client.joinOrCreate('dushi', { code: CODE, token: accounts[i].token });
    rooms.push(room);
    const idx = i;
    room.onMessage('view', (v: View) => {
      latest.set(idx, v);
      audit(idx, v);
    });
    room.onMessage('error', (e: { msg: string }) => {
      // 客户端策略可能出非法牌（例如 trick 变化竞态），记录但不致命
      console.log(`  [error→${idx}] ${e.msg}`);
    });
  }
  console.log(`4 客户端入房 ${CODE}`);

  // ── 房号隔离：换一个房号必须建出另一个房间，不能被 joinOrCreate 并进同一个 ──
  const CODE2 = String(Number(CODE) + 1).padStart(6, '0');
  const otherRoom = await client.joinOrCreate('dushi', { code: CODE2, token: accounts[0].token });
  const otherView = await new Promise<View>((resolve) => {
    otherRoom.onMessage('view', (v: View) => resolve(v));
  });
  otherRoom.leave();
  if (otherView.roomCode !== CODE2 || otherView.you !== 0) {
    await sleep(100);
    if (stop) stop();
    console.error(`✗ 房号隔离失效：进 ${CODE2} 却拿到房号 ${otherView.roomCode} / 座位 ${otherView.you}`);
    process.exit(1);
  }
  console.log(`✓ 房号隔离正常（${CODE} / ${CODE2} 是两个独立房间）`);

  await sleep(300);
  rooms.forEach((r) => r.send('ready', { ready: true }));

  const lastSig = new Map<number, string>();
  const driver = setInterval(() => {
    for (let i = 0; i < rooms.length; i++) {
      const v = latest.get(i);
      if (!v || v.phase === 'settling' || v.phase === 'waiting') continue;

      if (v.phase === 'declaring') {
        if (v.declareAsk) rooms[i].send('declare', { choice: 'none' });
        continue;
      }

      if (v.turn !== v.you) continue;
      const hand = v.yourHand ?? [];
      if (hand.length === 0) continue;
      const sig = `${v.trick ? v.trick.cards.map(label).join(',') : 'lead'}|${hand.length}`;
      if (lastSig.get(i) === sig) continue;
      lastSig.set(i, sig);

      if (!v.trick) {
        rooms[i].send('play', { cards: [label(smallest(hand))] });
      } else if (v.trick.cards.length === 1) {
        const need = power(v.trick.cards[0]);
        const beat = smallest(hand.filter((c) => power(c) > need));
        if (beat) rooms[i].send('play', { cards: [label(beat)] });
        else rooms[i].send('pass', {});
      } else {
        rooms[i].send('pass', {});
      }
    }
  }, 200);

  const allSettled = await Promise.race([
    Promise.all(finished).then(() => true),
    sleep(90_000).then(() => false),
  ]);
  clearInterval(driver);

  console.log(`\n视图总数 ${viewCount}`);

  const fail = async (msg: string): Promise<never> => {
    console.error(`✗ ${msg}`);
    for (const r of rooms) {
      try {
        r.leave();
      } catch {
        /* ignore */
      }
    }
    if (stop) stop();
    await sleep(150);
    process.exit(1);
  };

  if (leaks.length) {
    leaks.slice(0, 8).forEach((l) => console.error('  ' + l));
    await fail('手牌泄露');
  }
  console.log('✓ 无手牌泄露（审计通过）');

  if (!allSettled) {
    for (const v of latest.values()) {
      console.error(`  seat=${v.you} phase=${v.phase} turn=${v.turn} trick=${v.trick?.cards.join(' ') ?? '-'} hand=${v.yourHand?.length}`);
    }
    await fail('90 秒内未打完');
  }

  const finalViews = await Promise.all(finished);
  const deltas = finalViews[0].settle!.deltas;
  const sum = deltas.reduce((a, b) => a + b, 0);
  console.log(`✓ 对局完成，4 人全部收到结算 deltas=${JSON.stringify(deltas)} 零和=${sum === 0}`);
  if (sum !== 0) await fail('结算非零和');

  // ── 生涯分入库校验：每个座位的人 /api/me 总分必须等于本局 delta ──
  for (let seat = 0; seat < 4; seat++) {
    const stats = await careerOf(accounts[seat].token);
    if (stats.totalScore !== deltas[seat] || stats.games !== 1) {
      await fail(
        `生涯分不对：座位 ${seat}(${accounts[seat].username}) 期望 totalScore=${deltas[seat]} games=1，实际 ${JSON.stringify(stats)}`,
      );
    }
  }
  console.log('✓ 生涯分已入库，4 人均与本局 delta 一致');

  // 座位名必须来自账号，视图里必须带生涯分
  const namesOk = finalViews.every((v) =>
    v.seats.every((s, i) => s.name === accounts[i].username && s.career !== null),
  );
  if (!namesOk) await fail('座位名/生涯分未按账号下发');
  console.log('✓ 座位名与生涯分随视图下发');

  for (const r of rooms) {
    try {
      r.leave();
    } catch {
      /* ignore */
    }
  }
  if (stop) stop();
  await sleep(150);
  console.log('\nE2E 全部通过 ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
