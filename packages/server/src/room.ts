/**
 * 独食房间（Colyseus Room）。
 *
 * 同步策略（设计文档 §5.2）：不使用 Colyseus 的共享 state 同步 —— 那会把所有手牌
 * 广播给全员。房间状态只存在于服务端内存，每次变化后为每个座位单独计算"可见视图"
 * （views.ts），通过 private message 下发。客户端不发任何"判断"，只发"意图"。
 *
 * 鉴权（M2）：进房前必须已登录 —— onAuth 从 WS 握手携带的 cookie（或 join options.token，
 * 给脚本/测试用）验签，拿不到有效会话就拒绝入房。座位因此天然绑定账号，结算才能落到生涯分上。
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

const BOT_DELAY_MS = 4_000;
const ROUNDS = 8;

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
  state: GameState | null = null;
  clients: (Client | null)[] = [null, null, null, null];
  ready: boolean[] = [false, false, false, false];
  seatNames: string[] = ['空位', '空位', '空位', '空位'];
  /** 每个座位当前坐着的账号 */
  seatUsers: (SeatUser | null)[] = [null, null, null, null];
  /** 本局开打时的座位账号快照 —— 结算按这个算，中途换人不影响已开局的那一局 */
  roundUsers: (SeatUser | null)[] = [null, null, null, null];
  matchId: number | null = null;
  lastSettle: SettleResult | null = null;
  /** 本局生涯分变化（seat → Δ），结算弹窗用 */
  careerDelta: number[] = [0, 0, 0, 0];
  phase: 'waiting' | 'ingame' = 'waiting';
  hostSeat = 0;
  declareDeadline = 0;

  constructor(roomCode: string, rules = makeRules({ matchMode: 'rounds', rounds: ROUNDS })) {
    this.roomCode = roomCode;
    this.rules = rules;
  }

  clientSlots(): (Client | null)[] {
    return this.clients;
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
    this.g = new GameRuntime(code);

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
    // 同一账号不允许占两个座位（两个标签页），否则会重复记分
    const dup = this.g.seatUsers.findIndex((u) => u?.id === user.id);
    if (dup !== -1) {
      client.send('error', { msg: '这个账号已经在这个房间了，别开两个窗口' });
      client.leave();
      return;
    }
    const seat = this.g.clients.indexOf(null);
    if (seat === -1) {
      client.send('error', { msg: '房间满了（4 人）' });
      client.leave();
      return;
    }
    this.g.clients[seat] = client;
    this.g.seatUsers[seat] = user;
    this.g.seatNames[seat] = user.username;
    if (this.g.state) this.g.state.seats[seat].name = user.username;
    this.pushAll();
  }

  override onLeave(client: Client, consented: boolean): void {
    const seat = this.g.clients.indexOf(client);
    if (seat === -1) return;
    this.g.clients[seat] = null;
    this.g.ready[seat] = false;
    // 座位上的账号保留到本局结束：断线托管仍然在替这个人打，结算也该记在他头上
    if (this.g.state && this.g.phase === 'waiting') this.g.seatUsers[seat] = null;
    if (this.g.state) {
      this.g.state.log.push(`${this.g.seatNames[seat]} ${consented ? '离开' : '断线'}`);
    }
    this.pushAll();
    // 对局中掉线：延时托管，不踢座位（允许刷新重开一局再进）
    this.scheduleBotIfNeeded();
  }

  override onDispose(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const t of [this.declareTimer, this.botTimer, this.roundOverTimer]) if (t) clearTimeout(t);
    this.declareTimer = this.botTimer = this.roundOverTimer = null;
  }

  private seatOf(client: Client): number {
    return this.g.clients.indexOf(client);
  }

  // ── 消息处理 ─────────────────────────────────────────

  private handleReady(client: Client, msg: { ready?: unknown }): void {
    const seat = this.seatOf(client);
    if (seat === -1) return;
    this.g.ready[seat] = msg?.ready !== false;
    this.pushAll();
    if (this.g.phase === 'waiting' && this.allConnectedReady()) {
      this.startRound();
    }
  }

  private allConnectedReady(): boolean {
    return this.g.clients.every((c) => c !== null) && this.g.ready.every((r) => r);
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
      this.g.matchId = createMatch(this.g.roomCode, JSON.stringify(this.g.rules), seed);
    }
    this.pushAll();
    // 独食宣告倒计时
    if (this.g.state.phase === 'declaring') {
      this.declareTimer = setTimeout(() => {
        if (this.g.state?.phase === 'declaring') {
          declare(this.g.state, 'none');
          this.g.state.log.push('独食者超时未表态，按不表态处理');
          this.pushAll();
        }
      }, this.g.rules.declareWindowMs);
    }
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
    // 其他人需要重新 ready
    this.g.ready = this.g.ready.map(() => false);
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
   * 写库失败不能影响牌局继续 —— 所以捕获后只记日志，服务端权威的"本场分"仍在内存里。
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
      const careers = recordRound(rows);
      for (let seat = 0; seat < 4; seat++) {
        const user = this.g.roundUsers[seat];
        const career = user ? careers.get(user.id) : undefined;
        if (user && career !== undefined) {
          this.g.careerDelta[seat] = result.deltas[seat];
          if (this.g.seatUsers[seat]?.id === user.id) this.g.seatUsers[seat]!.career = career;
          user.career = career;
        }
      }
    } catch (e) {
      console.error('[room] 结算写库失败', this.g.roomCode, e);
    }
  }

  /** 轮到断线玩家时，延时自动托管 */
  private scheduleBotIfNeeded(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    const st = this.g.state;
    if (!st || st.phase !== 'playing') return;
    const seat = st.currentSeat;
    if (this.g.clients[seat]) return;

    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      const s = this.g.state;
      if (!s || s.phase !== 'playing' || s.currentSeat !== seat || this.g.clients[seat]) return;
      const action = chooseAction(s, seat);
      if (action.type === 'play') {
        play(s, seat, action.cards);
        s.log.push(`🤖 ${this.g.seatNames[seat]} 托管出牌`);
        if (s.phase === 'settling') this.doSettle();
      } else {
        pass(s, seat);
        s.log.push(`🤖 ${this.g.seatNames[seat]} 托管不出`);
      }
      this.pushAll();
      this.scheduleBotIfNeeded();
    }, BOT_DELAY_MS);
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
