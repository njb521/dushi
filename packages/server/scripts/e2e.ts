/**
 * 端到端测试：4 个真客户端通过 WebSocket 联机打完一局，并做手牌泄露审计。
 *
 *   npm run e2e
 *
 * 自动拉起测试服务器（端口 3123，可被 DUSHI_E2E_PORT 覆盖；若该端口已有服务则复用）。
 *
 * 客户端只依据视图行事（自己的手牌 + 公开牌面），等价于 4 个真实玩家，
 * 不读取任何服务端内部状态 —— 这本身就是信息最小化的验证。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'colyseus.js';
import { RANK_POWER, SUIT_POWER } from '@dushi/rules';

const NAMES = ['甲', '乙', '丙', '丁'];
const PORT = Number(process.env.DUSHI_E2E_PORT ?? 3123);
const CODE = String(Math.floor(100_000 + Math.random() * 900_000));

interface View {
  phase: 'waiting' | 'playing' | 'declaring' | 'settling';
  you: number;
  turn: number | null;
  declareAsk: boolean;
  yourHand: { s: string; r: string }[] | null;
  trick: { seat: number; cards: { s: string; r: string }[]; cat: string } | null;
  baiPaiHand: { s: string; r: string }[] | null;
  scores: number[];
  settle: null | { reason: string; deltas: number[]; places: number[] };
  eventLog: string[];
  rulesNote: string;
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
    await fetch(`http://127.0.0.1:${PORT}/`);
    console.log(`复用已在 :${PORT} 的服务`);
    return null;
  } catch {
    /* 未启动 */
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, '..', 'src', 'index.ts')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`  [server!] ${d}`));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      console.log(`测试服务器已启动 :${PORT}`);
      return () => child.kill();
    } catch {
      /* 继续等 */
    }
  }
  child.kill();
  throw new Error('测试服务器启动失败');
}

async function main(): Promise<void> {
  const stop = await ensureServer();
  const client = new Client(`ws://127.0.0.1:${PORT}`);

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
    const room = await client.joinOrCreate('dushi', { code: CODE });
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
  rooms.forEach((r, i) => r.send('setName', { name: NAMES[i] }));
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
