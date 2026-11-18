/**
 * 为每个座位构建"可见视图"。
 *
 * 安全底线（设计文档 §5.2）：
 *  - yourHand 只含自己的牌
 *  - soloSeat / team 在揭示前绝不出现在任何视图里
 *  - 别人的手牌永远只以数量形式出现
 */

import type { Card, GameState } from '@dushi/rules';
import { matchProgress, patternName } from '@dushi/rules';
import type { MatchProgress } from '@dushi/rules';
import type { GameRuntime } from './room.ts';
import { publicRules, rulesSummary } from './rules-options.ts';
import type { PublicRules } from './rules-options.ts';

export interface SeatView {
  readonly seat: number;
  readonly name: string;
  readonly cards: number;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly revealed: boolean;
  readonly place: number | null;
  /** 该座位的生涯总分（AI 与未登录座位为 null） */
  readonly career: number | null;
  /** 单人模式里的 AI 对手 */
  readonly bot: boolean;
  /** 出完时把身份牌留在最后 → 判最后一名 */
  readonly identityLast: boolean;
}

export type Phase = 'waiting' | 'playing' | 'declaring' | 'settling';

export interface View {
  readonly phase: Phase;
  readonly you: number;
  readonly roomCode: string;
  readonly round: number;
  readonly yourHand: Card[] | null;
  readonly seats: SeatView[];
  readonly turn: number | null;
  readonly trick: {
    readonly seat: number;
    readonly cards: Card[];
    readonly cat: string;
  } | null;
  readonly passed: boolean[];
  /** 只有被询问的独食者会收到 true */
  readonly declareAsk: boolean;
  /** 摆牌后所有人可见 */
  readonly baiPaiHand: Card[] | null;
  readonly scores: number[];
  /** 本局生涯分变化（仅结算时有意义，其余时刻为 0） */
  readonly careerDelta: number[];
  readonly mustContainD4: boolean;
  /** 你能否选择"不出"（报单时为 false，客户端据此禁用按钮） */
  readonly canPass: boolean;
  readonly settle: null | {
    readonly reason: string;
    readonly deltas: number[];
    readonly places: number[];
    readonly soloSeat: number | null;
    readonly team: [number, number] | null;
    readonly baiPai: boolean;
  };
  readonly eventLog: readonly string[];
  readonly rulesNote: string;
  /** 单人练习房 */
  readonly practice: boolean;
  /** 本局有 AI 参与（因此不计生涯分） */
  readonly hasAi: boolean;
  /** 建房时开了 AI 补位（房主可点「AI 补位开局」） */
  readonly aiFill: boolean;
  /** 还空着几个座位（AI 坐的不算） */
  readonly emptySeats: number;
  /** 赛制进度（顶部显示「第 3/8 局」或「32/50 分」） */
  readonly match: MatchProgress;
  /** 可编辑房规 + 一句话摘要（等待室展示、房主修改用） */
  readonly rules: PublicRules & { summary: string };
}

/**
 * 对外可见的阶段。
 *
 * 独食宣告阶段只给"被问的那个人"看到。其余三人只要看到 `declaring`，
 * 就等于知道"本局存在暗独食" —— 而一张身份牌都没拿到的人是推不出这件事的
 * （他既不知道 ♠3、♠A 分在两家还是同在一家）。所以对外一律报 `playing`，
 * `turn` 此时为 null，看不出来有什么区别。
 */
export function publicPhase(st: GameState | null, seat: number): Phase {
  if (!st) return 'waiting';
  if (st.phase !== 'declaring') return st.phase;
  return st.soloSeat === seat ? 'declaring' : 'playing';
}

export function buildView(g: GameRuntime, seat: number): View {
  const st = g.state;
  const me = st?.seats[seat];
  const phase: Phase = g.phase === 'waiting' || !st ? 'waiting' : publicPhase(st, seat);

  const seats: SeatView[] = st
    ? st.seats.map((s) => ({
        seat: s.id,
        name: s.name,
        cards: s.hand.length,
        connected: g.occupied(s.id),
        ready: g.ready[s.id],
        revealed: s.revealed,
        place: s.place,
        career: g.careerAt(s.id),
        bot: g.isBot(s.id),
        identityLast: s.identityLast,
      }))
    : // 等待阶段还没有牌局：空座位就是没人坐，给 0 张而不是假装 13 张
      g.clientSlots().map((_c, id) => ({
        seat: id,
        name: g.seatNames[id],
        cards: 0,
        connected: g.occupied(id),
        ready: g.ready[id],
        revealed: false,
        place: null,
        career: g.careerAt(id),
        bot: g.isBot(id),
        identityLast: false,
      }));

  const showHand = phase !== 'waiting';
  const isSoloAsked = phase === 'declaring' && st?.soloSeat === seat;

  // 报单可过性只有轮到自己时才有意义
  let canPass = false;
  if (st && st.phase === 'playing' && st.trick !== null && st.currentSeat === seat) {
    canPass = g.canPassNow(seat);
  }

  // 结算后才揭示独食者/队伍
  const settled = phase === 'settling';

  return {
    phase,
    you: seat,
    roomCode: g.roomCode,
    round: st?.round ?? 0,
    yourHand: showHand && me ? me.hand : null,
    seats,
    turn: st && st.phase === 'playing' ? st.currentSeat : null,
    trick: st?.trick
      ? {
          seat: st.trick.seat,
          cards: [...st.trick.cards],
          cat: patternName(st.trick.pattern),
        }
      : null,
    passed: st ? [...st.passed] : [false, false, false, false],
    declareAsk: isSoloAsked,
    baiPaiHand: st?.baiPai && st.soloSeat !== null ? [...st.seats[st.soloSeat].hand] : null,
    scores: st ? [...st.scores] : [0, 0, 0, 0],
    careerDelta: settled ? [...g.careerDelta] : [0, 0, 0, 0],
    mustContainD4: !!st && !st.firstPlayDone && st.requireD4 && st.currentSeat === seat,
    canPass,
    settle: settled && g.lastSettle && st
      ? {
          reason: g.lastSettle.reason,
          deltas: g.lastSettle.deltas,
          places: [...st.places],
          soloSeat: st.soloSeat,
          team: st.team,
          baiPai: st.baiPai,
        }
      : null,
    eventLog: st ? st.log.slice(-12) : [],
    rulesNote: g.rulesNote(),
    practice: g.practice,
    hasAi: g.roundHasAi(),
    aiFill: g.aiFill,
    emptySeats: g.emptySeats(),
    match: matchProgress(st?.round ?? 0, st?.scores ?? [0, 0, 0, 0], g.rules, g.matchOver),
    rules: { ...publicRules(g.rules), summary: rulesSummary(g.rules) },
  };
}
