/**
 * 视图契约。与服务端 packages/server/src/views.ts 保持一致，
 * 这是客户端与服务端之间唯一的消息形状（服务端推 view / 客户端发意图）。
 */

import type { Card, Phase } from '@dushi/rules';
import type { Suit } from '@dushi/rules';

export type { Card, Phase };

export interface SeatView {
  seat: number;
  name: string;
  cards: number;
  connected: boolean;
  ready: boolean;
  revealed: boolean;
  place: number | null;
  /** 生涯总分；未登录账号的座位为 null */
  career: number | null;
  /** 单人模式里的 AI 对手 */
  bot: boolean;
}

export interface SettleInfo {
  reason: string;
  deltas: number[];
  places: number[];
  soloSeat: number | null;
  team: [number, number] | null;
  baiPai: boolean;
}

export interface View {
  phase: Phase;
  you: number;
  roomCode: string;
  round: number;
  yourHand: Card[] | null;
  seats: SeatView[];
  turn: number | null;
  trick: { seat: number; cards: Card[]; cat: string } | null;
  passed: boolean[];
  declareAsk: boolean;
  baiPaiHand: Card[] | null;
  scores: number[];
  /** 本局生涯分变化，仅结算时有意义 */
  careerDelta: number[];
  mustContainD4: boolean;
  canPass: boolean;
  settle: SettleInfo | null;
  eventLog: string[];
  rulesNote: string;
  /** 单人练习房：不计生涯分 */
  practice: boolean;
}

export const SUIT_CHAR: Record<Suit, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const isRed = (s: Suit) => s === 'H' || s === 'D';

export function cardCode(c: Card): string {
  return `${c.s}${c.r}`;
}

export const PLACE_NAMES = ['', '头游', '二游', '三游', '四游'] as const;
