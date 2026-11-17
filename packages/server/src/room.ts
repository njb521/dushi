/**
 * 独食房间（Colyseus Room）。
 *
 * 同步策略（设计文档 §5.2）：不使用 Colyseus 的共享 state 同步 —— 那会把所有手牌
 * 广播给全员。房间状态只存在于服务端内存，每次变化后为每个座位单独计算"可见视图"
 * （views.ts），通过 private message 下发。客户端不发任何"判断"，只发"意图"。
 */

import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
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

const BOT_DELAY_MS = 4_000;
const ROUNDS = 8;

export interface PlayMsg {
  cards: string[];
}
export interface DeclareMsg {
  choice: 'none' | 'baiPai' | 'surrender';
}

/** 房间持有的对局运行时（独立成类方便 views.ts 只依赖窄接口） */
export class GameRuntime {
  readonly roomCode: string;
  readonly rules: ReturnType<typeof makeRules>;
  state: GameState | null = null;
  clients: (Client | null)[] = [null, null, null, null];
  ready: boolean[] = [false, false, false, false];
  seatNames: string[] = ['空位', '空位', '空位', '空位'];
  lastSettle: SettleResult | null = null;
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
    this.onMessage('setName', (client, msg) => this.handleSetName(client, msg));
    this.onMessage('play', (client, msg) => this.handlePlay(client, msg as PlayMsg));
    this.onMessage('pass', (client) => this.handlePass(client));
    this.onMessage('declare', (client, msg) => this.handleDeclare(client, msg as DeclareMsg));
    this.onMessage('nextRound', (client) => this.handleNextRound(client));
    this.onMessage('chat', (client, msg) => this.handleChat(client, msg));
    this.onMessage('debugRequestHand', (client) => {
      client.send('error', { msg: '手牌只通过视图下发，这里没有额外信息可给。' });
    });
  }

  override onJoin(client: Client): void {
    const seat = this.g.clients.indexOf(null);
    if (seat === -1) {
      client.leave();
      return;
    }
    this.g.clients[seat] = client;
    this.pushAll();
  }

  override onLeave(client: Client, consented: boolean): void {
    const seat = this.g.clients.indexOf(client);
    if (seat === -1) return;
    this.g.clients[seat] = null;
    this.g.ready[seat] = false;
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

  private handleSetName(client: Client, msg: { name?: unknown }): void {
    const seat = this.seatOf(client);
    if (seat === -1 || this.g.phase !== 'waiting') return;
    const name = sanitizeName(msg?.name);
    this.g.seatNames[seat] = name;
    if (this.g.state) this.g.state.seats[seat].name = name;
    this.pushAll();
  }

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
    this.g.state = createGame(this.g.seatNames, Math.floor(Math.random() * 2 ** 31), this.g.rules, round);
    this.g.state.scores = prevScores;
    this.g.lastSettle = null;
    this.g.phase = 'ingame';
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
    if (st.round >= ROUNDS) {
      this.roundOverTimer = setTimeout(() => this.pushAll(), 0);
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

function sanitizeName(name: unknown): string {
  const s = String(name ?? '').trim().slice(0, 12);
  return s || `玩家${Math.floor(Math.random() * 90 + 10)}`;
}
