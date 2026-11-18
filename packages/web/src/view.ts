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
  /** 出完时身份牌留到最后（判最后一名） */
  identityLast: boolean;
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
  /** 单人练习房 */
  practice: boolean;
  /** 本局有 AI 参与（不计生涯分） */
  hasAi: boolean;
  /** 建房时开了 AI 补位 */
  aiFill: boolean;
  /** 还空着几个座位（AI 坐的不算） */
  emptySeats: number;
  /** 赛制进度 */
  match: {
    mode: 'rounds' | 'targetScore' | 'endless';
    round: number;
    rounds: number;
    target: number;
    totals: number[];
    over: boolean;
    label: string;
  };
  /** 可编辑房规 + 一句话摘要 */
  rules: RuleDraft & { summary: string };
}

/** 建房面板上与房规相关的字段（与服务端 rules-options.ts 的 PublicRules 对齐） */
export interface RuleDraft {
  matchMode: 'rounds' | 'targetScore' | 'endless';
  rounds: number;
  targetScore: number;
  tripsOnlyWhenThreeLeft: boolean;
  mustPlayWhenReporting: boolean;
  baiPaiLeadsFirst: boolean;
  baiPaiMultiplier: number;
  allowSurrender: boolean;
}

export const SUIT_CHAR: Record<Suit, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const isRed = (s: Suit) => s === 'H' || s === 'D';

export function cardCode(c: Card): string {
  return `${c.s}${c.r}`;
}

export const PLACE_NAMES = ['', '头游', '二游', '三游', '四游'] as const;
