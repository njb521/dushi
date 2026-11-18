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
  practice: boolean;
  hasAi: boolean;
  aiFill: boolean;
  emptySeats: number;
  seats: { seat: number; name: string; career: number | null; bot: boolean; connected: boolean }[];
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

/** 带会话 cookie 的 GET（战绩接口都要求登录） */
async function apiGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: `dushi_session=${token}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/**
 * 一个人把一局打完（其余座位是 AI）：只按视图行事，等价于真人操作。
 * 单人练习和"AI 补位"两条路径都用它，省得写两套一模一样的策略。
 */
async function driveAlone(room: any, seedView: View | null, what: string): Promise<View> {
  let latest: View | null = seedView;
  let settled: View | null = null;
  room.onMessage('view', (v: View) => {
    latest = v;
    if (v.settle) settled = v;
  });
  room.send('ready', { ready: true });

  let sig = '';
  // 一局大约 50 手，AI 0.8 秒一手 → 40 秒上下，给足余量避免慢机器上误判
  const deadline = Date.now() + 120_000;
  while (!settled && Date.now() < deadline) {
    await sleep(200);
    const v = latest;
    if (!v) continue;
    if (v.phase === 'declaring') {
      if (v.declareAsk) room.send('declare', { choice: 'none' });
      continue;
    }
    if (v.phase !== 'playing' || v.turn !== v.you) continue;
    const hand = v.yourHand ?? [];
    if (hand.length === 0) continue;
    const s = `${v.trick ? v.trick.cards.map(label).join(',') : 'lead'}|${hand.length}`;
    if (s === sig) continue;
    sig = s;
    if (!v.trick) room.send('play', { cards: [label(smallest(hand))] });
    else if (v.trick.cards.length === 1) {
      const beat = smallest(hand.filter((c) => power(c) > power(v.trick!.cards[0])));
      if (beat) room.send('play', { cards: [label(beat)] });
      else room.send('pass', {});
    } else room.send('pass', {});
  }
  if (!settled) {
    const v = latest as View | null;
    throw new Error(`${what} 120 秒内没打完：phase=${v?.phase} turn=${v?.turn} 手牌=${v?.yourHand?.length}`);
  }
  return settled as View;
}

async function main(): Promise<void> {
  const stop = await ensureServer();
  const client = new Client(`ws://127.0.0.1:${PORT}`);

  // ── 0. 账号链路：注册 → 未登录必须被拒 → 带 token 才能进房 ──
  const accounts = await registerAccounts();
  console.log(`已注册 4 个测试账号：${accounts.map((a) => a.username).join(' ')}`);

  // ── 用户名查重接口：注册页边打边查用的那条 ──
  const probe = async (name: string): Promise<{ available: boolean; reason?: string }> =>
    (await fetch(`${BASE}/api/username-available?name=${encodeURIComponent(name)}`)).json() as Promise<{
      available: boolean;
      reason?: string;
    }>;
  const takenName = await probe(accounts[0].username);
  const freshName = await probe(`空名${Math.floor(Math.random() * 90000 + 10000)}`);
  const badName = await probe('a b');
  if (takenName.available !== false || takenName.reason !== 'taken') {
    if (stop) stop();
    console.error(`✗ 查重没识别出已占用：${JSON.stringify(takenName)}`);
    process.exit(1);
  }
  if (freshName.available !== true || badName.reason !== 'invalid') {
    if (stop) stop();
    console.error(`✗ 查重对新名字/非法名字判断不对：${JSON.stringify([freshName, badName])}`);
    process.exit(1);
  }
  console.log('✓ 用户名查重：已占用 / 可用 / 格式非法 三种都判对');

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
    // 公共日志一旦出现"谁表了态"，暗独食的身份就当场曝光了（三个人都收得到这份日志）
    for (const line of v.eventLog) {
      if (/不表态|未表态|暗打/.test(line)) {
        leaks.push(`座位 ${who}：公共日志泄露独食表态 → ${line}`);
      }
    }
    if (v.phase === 'settling' && v.settle && !settledIdx.has(who)) {
      settledIdx.add(who);
      resolvers[who](v);
    }
  };

  /** 把一个（可能重连后新建的）房间挂到某个座位上 */
  const bindClient = (idx: number, room: any): void => {
    rooms[idx] = room;
    room.onMessage('view', (v: View) => {
      latest.set(idx, v);
      audit(idx, v);
    });
    room.onMessage('error', (e: { msg: string }) => {
      // 客户端策略可能出非法牌（例如 trick 变化竞态），记录但不致命
      console.log(`  [error→${idx}] ${e.msg}`);
    });
  };

  for (let i = 0; i < NAMES.length; i++) {
    const room = await client.joinOrCreate('dushi', { code: CODE, token: accounts[i].token });
    bindClient(i, room);
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

  // ── 断线重连：开局后把 3 号座位拽断线，再从凭证接回来 ──
  const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (cond()) return true;
      await sleep(100);
    }
    return cond();
  };
  if (!(await waitFor(() => [...latest.values()].every((v) => v.phase === 'playing'), 15_000))) {
    if (stop) stop();
    console.error('✗ 15 秒内没进入出牌阶段，无法测重连');
    process.exit(1);
  }
  const before = latest.get(3)!;
  const handBefore = before.yourHand?.length ?? 0;
  const reconnectionToken = rooms[3].reconnectionToken as string;
  await rooms[3].leave(false); // 不带 consent 地断开 = 模拟掉线
  await sleep(700);
  let resumed: any = null;
  try {
    resumed = await new Client(`ws://127.0.0.1:${PORT}`).reconnect(reconnectionToken);
  } catch (e) {
    if (stop) stop();
    console.error('✗ 重连失败：', (e as Error).message);
    process.exit(1);
  }
  bindClient(3, resumed);
  if (!(await waitFor(() => !!latest.get(3) && latest.get(3)!.yourHand !== null, 5_000))) {
    if (stop) stop();
    console.error('✗ 重连后没收到手牌视图');
    process.exit(1);
  }
  const after = latest.get(3)!;
  if (after.you !== 3 || (after.yourHand?.length ?? 0) > handBefore) {
    if (stop) stop();
    console.error(`✗ 重连后座位/手牌不对：座位 ${after.you}，手牌 ${after.yourHand?.length}（原 ${handBefore}）`);
    process.exit(1);
  }
  console.log(`✓ 断线重连：座位 ${after.you} 恢复，手牌 ${after.yourHand?.length} 张未丢`);

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

  // ── 单人模式：1 个人类 + 3 个 AI，打完一局且不涨生涯分 ──
  const soloCode = String(300_000 + Math.floor(Math.random() * 600_000));
  const soloClient = new Client(`ws://127.0.0.1:${PORT}`);
  const soloRoom = await soloClient.joinOrCreate('dushi', {
    code: soloCode,
    token: accounts[0].token,
    solo: true,
  });
  const firstSolo = await new Promise<View>((resolve) => {
    soloRoom.onMessage('view', (v: View) => resolve(v));
  });
  const bots = firstSolo.seats.filter((s) => s.bot);
  if (bots.length !== 3 || !firstSolo.practice) {
    await fail(`单人房没填满 AI：bots=${bots.length} practice=${firstSolo.practice}`);
  }
  if (firstSolo.seats.some((s) => s.bot && !s.connected)) await fail('AI 座位不应显示为断线');
  console.log(`✓ 单人房就绪：3 个 AI（${bots.map((s) => s.name).join('、')}）`);

  const careerBeforeSolo = await careerOf(accounts[0].token);
  let soloSettled: View;
  try {
    soloSettled = await driveAlone(soloRoom, firstSolo, '单人局');
  } catch (e) {
    await fail((e as Error).message);
    throw e;
  }
  const aiPlayed = soloSettled.eventLog.some((l) => l.includes('🤖'));
  if (!aiPlayed) await fail('AI 没有出过牌');
  console.log(`✓ 单人局打完：AI 正常出牌，deltas=${JSON.stringify(soloSettled.settle!.deltas)}`);

  const careerAfterSolo = await careerOf(accounts[0].token);
  if (careerAfterSolo.totalScore !== careerBeforeSolo.totalScore || careerAfterSolo.games !== careerBeforeSolo.games) {
    await fail(
      `练习局不该动生涯分：前 ${JSON.stringify(careerBeforeSolo)} → 后 ${JSON.stringify(careerAfterSolo)}`,
    );
  }
  console.log('✓ 练习局不计生涯分');
  soloRoom.leave();

  // ── AI 补位：建房时开 aiFill，房主点一下把空位补成 AI 并直接开局 ──
  const fillCode = String(400_000 + Math.floor(Math.random() * 500_000));
  const fillClient = new Client(`ws://127.0.0.1:${PORT}`);
  const fillRoom = await fillClient.joinOrCreate('dushi', {
    code: fillCode,
    token: accounts[1].token,
    aiFill: true,
  });
  let latestFill = await new Promise<View>((resolve) => {
    fillRoom.onMessage('view', (v: View) => resolve(v));
  });
  fillRoom.onMessage('view', (v: View) => {
    latestFill = v;
  });
  if (!latestFill.aiFill || latestFill.emptySeats !== 3 || latestFill.seats.some((s) => s.bot)) {
    await fail(
      `AI 补位房初始状态不对：aiFill=${latestFill.aiFill} 空位=${latestFill.emptySeats} 现有AI=${latestFill.seats.filter((s) => s.bot).length}`,
    );
  }
  console.log('✓ AI 补位房就绪：只有房主 1 人，3 个空位等着');

  const careerBeforeFill = await careerOf(accounts[1].token);
  fillRoom.send('fillAi');
  await sleep(900);
  const botNames = latestFill.seats.filter((s) => s.bot).map((s) => s.name);
  if (botNames.length !== 3 || !latestFill.hasAi || latestFill.phase === 'waiting') {
    await fail(`AI 补位没生效：AI=${botNames.length} hasAi=${latestFill.hasAi} phase=${latestFill.phase}`);
  }
  console.log(`✓ 房主一点就补位开局：${botNames.join('、')}`);

  let fillSettled: View;
  try {
    fillSettled = await driveAlone(fillRoom, latestFill, 'AI 补位局');
  } catch (e) {
    await fail((e as Error).message);
    throw e;
  }
  console.log(`✓ AI 补位局打完：deltas=${JSON.stringify(fillSettled.settle!.deltas)}`);

  const careerAfterFill = await careerOf(accounts[1].token);
  if (careerAfterFill.totalScore !== careerBeforeFill.totalScore || careerAfterFill.games !== careerBeforeFill.games) {
    await fail(
      `有 AI 的局不该动生涯分：前 ${JSON.stringify(careerBeforeFill)} → 后 ${JSON.stringify(careerAfterFill)}`,
    );
  }
  console.log('✓ 有 AI 参与的局不计生涯分');

  // ── 局间来人可以接管 AI 的座位（"朋友来了，替下 AI"）──
  fillRoom.send('nextRound');
  await sleep(600);
  const takerRoom = await fillClient.joinOrCreate('dushi', {
    code: fillCode,
    token: accounts[2].token,
    aiFill: true,
  });
  const takerView = await new Promise<View>((resolve) => {
    takerRoom.onMessage('view', (v: View) => resolve(v));
  });
  const botsLeft = takerView.seats.filter((s) => s.bot).length;
  const tookSeat = takerView.seats.some((s) => s.name === accounts[2].username);
  if (botsLeft !== 2 || !tookSeat) {
    await fail(`接管 AI 座位失败：剩 ${botsLeft} 个 AI，座位里有新人=${tookSeat}`);
  }
  console.log(`✓ 局间进来的朋友接管了一个 AI 座位（剩 ${botsLeft} 个 AI）`);
  takerRoom.leave();
  fillRoom.leave();

  // ── M4：赛制可配置 ─────────────────────────────────────
  const expectError = (room: any, send: () => void, what: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what}：没收到错误消息`)), 2000);
      room.onMessage('error', function onErr(e: { msg: string }) {
        clearTimeout(timer);
        resolve(e.msg);
      });
      send();
    });

  // ① 自定义 2 局制：打完第 2 局自动结束
  const rulesCode = String(500_000 + Math.floor(Math.random() * 400_000));
  const rulesRoom = await new Client(`ws://127.0.0.1:${PORT}`).joinOrCreate('dushi', {
    code: rulesCode,
    token: accounts[3].token,
    solo: true,
    rules: { matchMode: 'rounds', rounds: 2 },
  });
  const rulesFirst = await new Promise<View>((resolve) => {
    rulesRoom.onMessage('view', (v: View) => resolve(v));
  });
  if (rulesFirst.match.mode !== 'rounds' || rulesFirst.match.rounds !== 2) {
    await fail(`自定义赛制没生效：${JSON.stringify(rulesFirst.match)}`);
  }

  const round1 = await driveAlone(rulesRoom, rulesFirst, '自定义 2 局制 · 第 1 局');
  if (round1.match.over) await fail('第 1 局就判结束了（应该是 2 局制）');
  rulesRoom.send('nextRound');
  await sleep(600);
  const round2 = await driveAlone(rulesRoom, null, '自定义 2 局制 · 第 2 局');
  if (!round2.match.over) await fail(`第 2 局打完没有结束：${JSON.stringify(round2.match)}`);
  const rejectMsg = await expectError(rulesRoom, () => rulesRoom.send('nextRound'), '结束后再开下一局');
  if (!/结束/.test(rejectMsg)) await fail(`结束后还能开下一局：${rejectMsg}`);
  console.log(`✓ 自定义 2 局制：第 2 局打完自动结束（${round2.match.label}），且拒绝再开`);
  rulesRoom.leave();

  // ② 无限赛制 + 房主喊停
  const endlessCode = String(600_000 + Math.floor(Math.random() * 300_000));
  const endlessRoom = await new Client(`ws://127.0.0.1:${PORT}`).joinOrCreate('dushi', {
    code: endlessCode,
    token: accounts[2].token,
    solo: true,
    rules: { matchMode: 'endless' },
  });
  const endlessFirst = await new Promise<View>((resolve) => {
    endlessRoom.onMessage('view', (v: View) => resolve(v));
  });
  if (endlessFirst.match.label !== '打到喊停') await fail(`无限赛制文案不对：${endlessFirst.match.label}`);
  const endlessRound = await driveAlone(endlessRoom, endlessFirst, '无限赛制 · 第 1 局');
  if (endlessRound.match.over) await fail('无限赛制不该自动结束');
  let endlessLatest: View = endlessRound;
  endlessRoom.onMessage('view', (v: View) => {
    endlessLatest = v;
  });
  endlessRoom.send('endMatch');
  await sleep(500);
  if (!endlessLatest.match.over) await fail('房主喊停没生效');
  console.log('✓ 无限赛制：第 1 局后房主喊停，本场结束');
  endlessRoom.leave();

  // ③ 目标分制：这里只验接线（打的局数不确定，结束判定由单测覆盖）
  const targetCode = String(700_000 + Math.floor(Math.random() * 200_000));
  const targetRoom = await new Client(`ws://127.0.0.1:${PORT}`).joinOrCreate('dushi', {
    code: targetCode,
    token: accounts[0].token,
    solo: true,
    rules: { matchMode: 'targetScore', targetScore: 10 },
  });
  const targetFirst = await new Promise<View>((resolve) => {
    targetRoom.onMessage('view', (v: View) => resolve(v));
  });
  if (targetFirst.match.mode !== 'targetScore' || targetFirst.match.target !== 10) {
    await fail(`目标分制没接线：${JSON.stringify(targetFirst.match)}`);
  }
  if (!/\/10 分$/.test(targetFirst.match.label)) await fail(`目标分制文案不对：${targetFirst.match.label}`);
  console.log(`✓ 目标分制接线正常：${targetFirst.match.label}`);
  targetRoom.leave();

  // ④ 战绩接口：上面打的局应该都能查到
  const hist = (await apiGet(accounts[3].token, '/api/history')) as {
    rows: { round_no: number; delta: number }[];
    nextCursor: number | null;
  };
  if (!hist.rows || hist.rows.length === 0) await fail('战绩没有记录');
  const summary = (await apiGet(accounts[3].token, '/api/stats/summary')) as { games: number; winRate: number };
  if (typeof summary.winRate !== 'number') await fail('概览接口字段不全');
  const boardRes = (await apiGet(accounts[3].token, '/api/leaderboard')) as {
    rows: unknown[];
    me: { rank: number | null };
  };
  if (!boardRes.me || !Array.isArray(boardRes.rows)) await fail('排行榜接口结构不对');
  console.log(`✓ 战绩接口：history ${hist.rows.length} 条 / 概览 / 排行榜 rank=${boardRes.me.rank}`);

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
