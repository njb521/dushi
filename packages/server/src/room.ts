/**
 * 独食房间（Colyseus Room）。
 *
 * 同步策略（设计文档 §5.2）：不使用 Colyseus 的共享 state 同步 —— 那会把所有手牌
 * 广播给全员。房间状态只存在于服务端内存，每次变化后为每个座位单独计算"可见视图"
 * （views.ts），通过 private message 下发。客户端不发任何"判断"，只发"意图"。
 *
 * 鉴权（M2）：进房前必须已登录 —— onAuth 从 WS 握手携带的 cookie（或 join options.token，
 * 给脚本/测试用）验签，拿不到有效会话就拒绝入房。座位因此天然绑定账号，结算才能落到生涯分上。
 *
 * 断线重连（M3）：非主动断开时座位保留 60 秒（allowReconnection），期间由托管按节奏替打；
 * 超时才释放座位。座位映射按 sessionId 认人，不按 Client 对象身份 —— 重连后服务端拿到的是
 * 一个新的 Client 实例。
 *
 * 单人模式：建房时 options.solo = true → 其余 3 座填 AI，用同一套规则引擎的 chooseAction 出牌。
 * 练习局照常入库（matches.vs_ai = 1）但不累加生涯分。
 */

import { Room, ServerError } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import type { AuthContext } from '@colyseus/core';
import type { Card, GameState, SettleResult } from '@dushi/rules';
import {
  canPass,
  chooseAction,
  createGame,
  declare,
  makeRules,
  parseCard,
  pass,
  play,
  settle,
  applyScores,
  validatePlay,
} from '@dushi/rules';
import { buildView } from './views.ts';
import type { View } from './views.ts';
import { COOKIE_NAME, parseCookies, resolveSession } from './auth/session.ts';
import type { SessionUser } from './auth/session.ts';
import { careerOf, createMatch, endMatch, recordRound } from './db.ts';
import type { RoundResultInput } from './db.ts';

const ROUNDS = 8;
/** 人类掉线后的托管节奏：慢一点，既给人重连的时间，也不至于把牌桌卡死 */
const TAKEOVER_DELAY_MS = 4_000;
/** 单人模式的 AI 出牌节奏：快，像坐在对面等你 */
const AI_DELAY_MS = 800;
/** 断线后座位保留多久（秒） */
const RECONNECT_SEC = 60;
const AI_NAMES = ['AI·阿良', 'AI·小陈', 'AI·老王'];

export interface PlayMsg {
  cards: string[];
}
export interface DeclareMsg {
  choice: 'none' | 'baiPai' | 'surrender';
}

/** 座位上的账号（进房时绑定；生涯分随结算刷新，仅用于展示） */
export interface SeatUser {
  id: number;
  username: string;
  career: number;
}

/** 房间持有的对局运行时（独立成类方便 views.ts 只依赖窄接口） */
export class GameRuntime {
  readonly roomCode: string;
  readonly rules: ReturnType<typeof makeRules>;
  /** 单人练习房：其余座位是 AI，且不计生涯分 */
  readonly practice: boolean;
  state: GameState | null = null;
  clients: (Client | null)[] = [null, null, null, null];
  /** 该座位是 AI（没有 Client，但永远"在座"且已准备） */
  bots: boolean[] = [false, false, false, false];
  ready: boolean[] = [false, false, false, false];
  seatNames: string[] = ['空位', '空位', '空位', '空位'];
  /** 每个座位当前坐着的账号（AI 与空位为 null） */
  seatUsers: (SeatUser | null)[] = [null, null, null, null];
  /** 本局开打时的座位账号快照 —— 结算按这个算，中途换人不影响已开局的那一局 */
  roundUsers: (SeatUser | null)[] = [null, null, null, null];
  matchId: number | null = null;
  lastSettle: SettleResult | null = null;
  /** 本局生涯分变化（seat → Δ），结算弹窗用；练习局恒为 0 */
  careerDelta: number[] = [0, 0, 0, 0];
  phase: 'waiting' | 'ingame' = 'waiting';
  hostSeat = 0;

  constructor(roomCode: string, rules = makeRules({ matchMode: 'rounds', rounds: ROUNDS }), practice = false) {
    this.roomCode = roomCode;
    this.rules = rules;
    this.practice = practice;
  }

  clientSlots(): (Client | null)[] {
    return this.clients;
  }

  isBot(seat: number): boolean {
    return this.bots[seat];
  }

  /** 座位是否有人（AI 也算有人） */
  occupied(seat: number): boolean {
    return this.bots[seat] || this.clients[seat] !== null;
  }

  /** 第一个没人坐的座位，没有则 -1 */
  freeSeat(): number {
    for (let s = 0; s < 4; s++) if (!this.occupied(s)) return s;
    return -1;
  }

  careerAt(seat: number): number | null {
    return this.seatUsers[seat]?.career ?? null;
  }

  canPassNow(seat: number): boolean {
    return this.state ? canPass(this.state, seat) : false;
  }

  rulesNote(): string {
    const r = this.rules;
    const mode = r.matchMode === 'rounds' ? `${r.rounds} 局` : r.matchMode === 'targetScore' ? `±${r.targetScore} 分` : '无限';
    return [
      this.practice ? '单人练习（不计生涯分）' : null,
      `顺子 4-8..10-A（2、3 不入顺）`,
      `同花只比花色`,
      `独食必须头游`,
      r.leadMustContainDiamond4 ? `首出必须含 ♦4` : null,
      `赛制：${mode}`,
    ]
      .filter(Boolean)
      .join(' · ');
  }
}

export class DushiRoom extends Room {
  override maxClients = 4;
  override autoDispose = false;
  private g!: GameRuntime;
  private declareTimer: ReturnType<typeof setTimeout> | null = null;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private roundOverTimer: ReturnType<typeof setTimeout> | null = null;

  override onCreate(options: Record<string, unknown>): void {
    const code = typeof options.code === 'string' && /^\d{6}$/.test(options.code) ? options.code : randomCode();
    this.g = new GameRuntime(code, undefined, options.solo === true);

    this.onMessage('ready', (client, msg) => this.handleReady(client, msg));
    this.onMessage('play', (client, msg) => this.handlePlay(client, msg as PlayMsg));
    this.onMessage('pass', (client) => this.handlePass(client));
    this.onMessage('declare', (client, msg) => this.handleDeclare(client, msg as DeclareMsg));
    this.onMessage('nextRound', (client) => this.handleNextRound(client));
    this.onMessage('chat', (client, msg) => this.handleChat(client, msg));
    this.onMessage('debugRequestHand', (client) => {
      client.send('error', { msg: '手牌只通过视图下发，这里没有额外信息可给。' });
    });
  }

  /**
   * 进房鉴权：会话来自 WS 握手的 cookie（浏览器自动带），脚本可用 options.token。
   * 未登录一律拒绝 —— 生涯分必须挂在稳定账号上，游客座位会让计分变成糊涂账。
   */
  override onAuth(
    _client: Client,
    options: { token?: unknown } | undefined,
    ctx: AuthContext | undefined,
  ): SeatUser {
    const fromOptions = typeof options?.token === 'string' ? options.token : null;
    const fromCookie = parseCookies(ctx?.headers?.cookie)[COOKIE_NAME] ?? null;
    const user: SessionUser | null = resolveSession(fromOptions ?? fromCookie);
    if (!user) throw new ServerError(401, '请先登录再进房');
    return { id: user.id, username: user.username, career: careerOf(user.id) };
  }

  override onJoin(client: Client, _options?: unknown, auth?: SeatUser): void {
    const user = auth ?? null;
    if (!user) {
      client.send('error', { msg: '登录状态失效，请重新登录' });
      client.leave();
      return;
    }
    // 练习房只留给建房那一个人，别人用同一个房号挤不进来
    if (this.g.practice && this.g.clients.some((c) => c !== null)) {
      client.send('error', { msg: '这是单人练习房，点"单人练习"自己开一间' });
      client.leave();
      return;
    }
    // 同一账号不允许占两个座位（两个标签页），否则会重复记分
    const dup = this.g.seatUsers.findIndex((u) => u?.id === user.id);
    if (dup !== -1) {
      client.send('error', { msg: '这个账号已经在这个房间了，别开两个窗口' });
      client.leave();
      return;
    }
    const seat = this.g.freeSeat();
    if (seat === -1) {
      client.send('error', { msg: '房间满了（4 人）' });
      client.leave();
      return;
    }
    this.g.clients[seat] = client;
    this.g.seatUsers[seat] = user;
    this.g.seatNames[seat] = user.username;
    if (this.g.state) this.g.state.seats[seat].name = user.username;
    if (this.g.practice) this.fillBots(seat);
    this.pushAll();
  }

  /** 单人模式：把剩下三个座位交给 AI */
  private fillBots(humanSeat: number): void {
    let n = 0;
    for (let s = 0; s < 4; s++) {
      if (s === humanSeat) continue;
      this.g.bots[s] = true;
      this.g.seatNames[s] = AI_NAMES[n % AI_NAMES.length];
      this.g.ready[s] = true;
      if (this.g.state) this.g.state.seats[s].name = this.g.seatNames[s];
      n++;
    }
  }

  override onLeave(client: Client, consented: boolean): void {
    const seat = this.seatOf(client);
    if (seat === -1) return;
    this.g.clients[seat] = null;
    this.g.ready[seat] = this.g.bots[seat];
    if (this.g.state) {
      this.g.state.log.push(`${this.g.seatNames[seat]} ${consented ? '离开' : '断线，座位保留 60 秒'}`);
    }
    this.pushAll();
    this.scheduleBotIfNeeded();

    // 主动退出（或这个座位本来就是 AI）→ 立刻释放
    if (consented || this.g.bots[seat]) {
      this.releaseSeat(seat);
      return;
    }

    // 意外断线 → 保留座位等他回来，期间托管继续出牌
    void this.allowReconnection(client, RECONNECT_SEC).then(
      (reconnected) => {
        this.g.clients[seat] = reconnected;
        this.g.ready[seat] = true;
        if (this.g.state) this.g.state.log.push(`${this.g.seatNames[seat]} 回来了`);
        this.pushAll();
        if (this.g.phase === 'waiting' && this.allSeatsReady()) this.startRound();
        this.scheduleBotIfNeeded();
      },
      () => {
        if (this.g.state) this.g.state.log.push(`${this.g.seatNames[seat]} 超时没回来，座位已释放`);
        this.releaseSeat(seat);
      },
    );
  }

  override onDispose(): void {
    this.clearTimers();
  }

  /** 座位彻底空出来（注意：对局中保留座位名，让托管的人把这一局打完） */
  private releaseSeat(seat: number): void {
    this.g.clients[seat] = null;
    this.g.ready[seat] = false;
    this.g.bots[seat] = false;
    this.g.seatUsers[seat] = null;
    if (!this.g.state || this.g.phase === 'waiting') {
      this.g.seatNames[seat] = '空位';
      if (this.g.state) this.g.state.seats[seat].name = '空位';
    }
    this.pushAll();
    // 练习房：人走了就没必要留着
    if (this.g.practice && this.g.clients.every((c) => c === null)) void this.disconnect();
  }

  private clearTimers(): void {
    for (const t of [this.declareTimer, this.botTimer, this.roundOverTimer]) if (t) clearTimeout(t);
    this.declareTimer = this.botTimer = this.roundOverTimer = null;
  }

  /**
   * 座位归属。重连后服务端拿到的是新的 Client 实例（Colyseus 内部把 sessionId 复用到新连接上），
   * 所以先按对象比，再按 sessionId 兜底 —— 否则重连后连"我是哪个座位"都认不出来。
   */
  private seatOf(client: Client): number {
    const direct = this.g.clients.indexOf(client);
    if (direct !== -1) return direct;
    return this.g.clients.findIndex((c) => c !== null && c.sessionId === client.sessionId);
  }

  // ── 消息处理 ─────────────────────────────────────────

  private handleReady(client: Client, msg: { ready?: unknown }): void {
    const seat = this.seatOf(client);
    if (seat === -1) return;
    this.g.ready[seat] = msg?.ready !== false;
    this.pushAll();
    if (this.g.phase === 'waiting' && this.allSeatsReady()) {
      this.startRound();
    }
  }

  /** 四个座位都有人（人或 AI）且都已准备 */
  private allSeatsReady(): boolean {
    for (let s = 0; s < 4; s++) {
      if (!this.g.occupied(s) || !this.g.ready[s]) return false;
    }
    return true;
  }

  private startRound(): void {
    const prevScores = this.g.state?.scores ?? [0, 0, 0, 0];
    const round = (this.g.state?.round ?? 0) + 1;
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.g.state = createGame(this.g.seatNames, seed, this.g.rules, round);
    this.g.state.scores = prevScores;
    this.g.lastSettle = null;
    this.g.careerDelta = [0, 0, 0, 0];
    this.g.phase = 'ingame';
    // 本局参与者快照：中途有人掉线/换人，结算仍记在开局时坐着的人身上
    this.g.roundUsers = this.g.seatUsers.map((u) => (u ? { ...u } : null));
    if (this.g.matchId === null) {
      this.g.matchId = createMatch(this.g.roomCode, JSON.stringify(this.g.rules), seed, this.g.practice);
    }
    this.pushAll();
    this.armDeclareTimer();
    // 首出者可能正好是 AI 或断线的人：给托管一个起点，否则牌桌会停在这里
    this.scheduleBotIfNeeded();
  }

  /** 独食宣告倒计时；AI 当独食时不用等满 10 秒 */
  private armDeclareTimer(): void {
    const st = this.g.state;
    if (!st || st.phase !== 'declaring') return;
    const soloSeat = st.soloSeat;
    const bot = soloSeat !== null && this.g.bots[soloSeat];
    const delay = bot ? AI_DELAY_MS * 2 : this.g.rules.declareWindowMs;
    this.declareTimer = setTimeout(() => {
      if (this.g.state?.phase !== 'declaring') return;
      declare(this.g.state, 'none');
      this.g.state.log.push(bot ? 'AI 不表态，暗打' : '独食者超时未表态，按不表态处理');
      this.pushAll();
      this.scheduleBotIfNeeded();
    }, delay);
  }

  private handleDeclare(client: Client, msg: DeclareMsg): void {
    const st = this.g.state;
    const seat = this.seatOf(client);
    if (!st || st.phase !== 'declaring' || seat === -1) return;
    if (st.soloSeat !== seat) {
      client.send('error', { msg: '你不是独食者，无需表态。' });
      return;
    }
    if (msg?.choice !== 'none' && msg?.choice !== 'baiPai' && msg?.choice !== 'surrender') return;
    if (this.declareTimer) clearTimeout(this.declareTimer);
    declare(st, msg.choice);
    if (st.phase === 'settling') {
      this.doSettle();
    } else {
      this.scheduleBotIfNeeded();
    }
    this.pushAll();
  }

  private handlePlay(client: Client, msg: PlayMsg): void {
    const st = this.g.state;
    const seat = this.seatOf(client);
    if (!st || st.phase !== 'playing' || seat === -1) {
      client.send('error', { msg: '现在不能出牌。' });
      return;
    }
    let cards: Card[];
    try {
      cards = (msg?.cards ?? []).map(parseCard);
    } catch {
      client.send('error', { msg: '卡牌格式错误。' });
      return;
    }
    const v = validatePlay(st, seat, cards);
    if (!v.ok) {
      client.send('error', { msg: v.reason ?? '非法出牌' });
      return;
    }
    play(st, seat, cards);
    if (st.phase === 'settling') {
      this.doSettle();
    } else {
      this.scheduleBotIfNeeded();
    }
    this.pushAll();
  }

  private handlePass(client: Client): void {
    const st = this.g.state;
    const seat = this.seatOf(client);
    if (!st || st.phase !== 'playing' || seat === -1) return;
    try {
      pass(st, seat);
    } catch (e) {
      client.send('error', { msg: (e as Error).message });
      return;
    }
    this.scheduleBotIfNeeded();
    this.pushAll();
  }

  private handleNextRound(client: Client): void {
    const st = this.g.state;
    if (!st || st.phase !== 'settling') return;
    if (this.seatOf(client) !== this.g.hostSeat) {
      client.send('error', { msg: '只有房主可以开始下一局。' });
      return;
    }
    if (st.round >= ROUNDS) {
      client.send('error', { msg: `已打完 ${ROUNDS} 局，本场结束。` });
      return;
    }
    // 其他人需要重新 ready（AI 由 fillBots 设为已准备）
    this.g.ready = this.g.ready.map((_, s) => this.g.bots[s]);
    this.g.phase = 'waiting';
    this.pushAll();
  }

  private handleChat(client: Client, msg: { text?: unknown }): void {
    const seat = this.seatOf(client);
    const text = String(msg?.text ?? '').slice(0, 120);
    if (seat === -1 || !text.trim()) return;
    this.g.state?.log.push(`💬 ${this.g.seatNames[seat]}: ${text.trim()}`);
    this.pushAll();
  }

  // ── 结算与托管 ───────────────────────────────────────

  private doSettle(): void {
    const st = this.g.state!;
    const result = settle(st);
    applyScores(st, result.deltas);
    this.g.lastSettle = result;
    st.log.push(`结算：${result.reason}`);
    this.persistRound(result);
    if (st.round >= ROUNDS) {
      if (this.g.matchId !== null) endMatch(this.g.matchId);
      this.roundOverTimer = setTimeout(() => this.pushAll(), 0);
    }
  }

  /**
   * 结算入库：一局 4 条 match_players + user_stats 累加（同一事务）。
   * 练习局只记历史不记分。写库失败不能影响牌局继续 —— 捕获后只记日志，
   * 服务端权威的"本场分"仍在内存里。
   */
  private persistRound(result: SettleResult): void {
    const st = this.g.state;
    const matchId = this.g.matchId;
    if (!st || matchId === null) return;

    const declared: 'none' | 'baiPai' | 'surrender' | null =
      st.surrendered ? 'surrender' : st.baiPai ? 'baiPai' : st.soloSeat !== null ? 'none' : null;

    const rows: RoundResultInput[] = [];
    for (let seat = 0; seat < 4; seat++) {
      const user = this.g.roundUsers[seat];
      if (!user) continue;
      rows.push({
        matchId,
        roundNo: st.round,
        userId: user.id,
        seat,
        place: st.seats[seat].place,
        isSolo: st.soloSeat === seat,
        declared: st.soloSeat === seat ? declared : null,
        delta: result.deltas[seat],
      });
    }

    try {
      const careers = recordRound(rows, this.g.practice);
      for (let seat = 0; seat < 4; seat++) {
        const user = this.g.roundUsers[seat];
        const career = user ? careers.get(user.id) : undefined;
        if (user && career !== undefined) {
          // 练习局不进生涯分，这里保持 0，避免 UI 显示成"涨了"
          this.g.careerDelta[seat] = this.g.practice ? 0 : result.deltas[seat];
          if (this.g.seatUsers[seat]?.id === user.id) this.g.seatUsers[seat]!.career = career;
          user.career = career;
        }
      }
    } catch (e) {
      console.error('[room] 结算写库失败', this.g.roomCode, e);
    }
  }

  /**
   * 轮到"没有客户端"的座位就自动出牌：
   *  - AI 座位：单人模式的对手，按 AI_DELAY_MS 的节奏
   *  - 人类但断线：托管，按 TAKEOVER_DELAY_MS 慢一点，给重连留时间
   */
  private scheduleBotIfNeeded(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    const st = this.g.state;
    if (!st || st.phase !== 'playing') return;
    const seat = st.currentSeat;
    if (this.g.clients[seat]) return;

    const isAi = this.g.bots[seat];
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      const s = this.g.state;
      if (!s || s.phase !== 'playing' || s.currentSeat !== seat || this.g.clients[seat]) return;
      const tag = isAi ? '🤖' : '⏳';
      const action = chooseAction(s, seat);
      if (action.type === 'play') {
        play(s, seat, action.cards);
        s.log.push(`${tag} ${this.g.seatNames[seat]} 出牌`);
        if (s.phase === 'settling') this.doSettle();
      } else {
        pass(s, seat);
        s.log.push(`${tag} ${this.g.seatNames[seat]} 不出`);
      }
      this.pushAll();
      this.scheduleBotIfNeeded();
    }, isAi ? AI_DELAY_MS : TAKEOVER_DELAY_MS);
  }

  // ── 下发 ─────────────────────────────────────────────

  private pushAll(): void {
    for (let seat = 0; seat < 4; seat++) {
      const client = this.g.clients[seat];
      if (!client) continue;
      const view: View = buildView(this.g, seat);
      client.send('view', view);
    }
  }
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += Math.floor(Math.random() * 10);
  return out;
}
