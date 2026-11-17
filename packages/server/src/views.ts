/**
 * 为每个座位构建"可见视图"。
 *
 * 安全底线（设计文档 §5.2）：
 *  - yourHand 只含自己的牌
 *  - soloSeat / team 在揭示前绝不出现在任何视图里
 *  - 别人的手牌永远只以数量形式出现
 */

import type { Card } from '@dushi/rules';
import { patternName } from '@dushi/rules';
import type { GameRuntime } from './room.ts';

export interface SeatView {
  readonly seat: number;
  readonly name: string;
  readonly cards: number;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly revealed: boolean;
  readonly place: number | null;
  /** 该座位的生涯总分（未登录的座位为 null） */
  readonly career: number | null;
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
}

export function buildView(g: GameRuntime, seat: number): View {
  const st = g.state;
  const me = st?.seats[seat];
  const phase: Phase =
    g.phase === 'waiting' || !st ? 'waiting' : st.phase === 'declaring' ? 'declaring' : st.phase === 'settling' ? 'settling' : 'playing';

  const seats: SeatView[] = st
    ? st.seats.map((s) => ({
        seat: s.id,
        name: s.name,
        cards: s.hand.length,
        connected: g.clients[s.id] !== null,
        ready: g.ready[s.id],
        revealed: s.revealed,
        place: s.place,
        career: g.careerAt(s.id),
      }))
    : // 等待阶段还没有牌局：空座位就是没人坐，给 0 张而不是假装 13 张
      g.clientSlots().map((c, id) => ({
        seat: id,
        name: g.seatNames[id],
        cards: 0,
        connected: c !== null,
        ready: g.ready[id],
        revealed: false,
        place: null,
        career: g.careerAt(id),
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
  };
}
