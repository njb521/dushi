/**
 * 可出牌型枚举：给定手牌和当前牌面，列出所有合法出法。
 * 用于「提示」、AI 和测试。
 */

import type { Card } from './cards.ts';
import { cardLabel } from './cards.ts';
import type { Pattern } from './pattern.ts';
import { beats, classify, compare } from './pattern.ts';

export interface Trick {
  readonly seat: number;
  readonly pattern: Pattern;
  readonly cards: readonly Card[];
}

export interface PlayOption {
  readonly pattern: Pattern;
  readonly cards: Card[];
}

/** 从 arr 中取 k 个的所有组合 */
export function* combinations<T>(arr: readonly T[], k: number): Generator<T[]> {
  const n = arr.length;
  if (k > n || k <= 0) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

export interface LegalOptions {
  /** 首出必须包含 ♦4 */
  readonly mustContainD4?: boolean;
}

function hasDiamond4(cards: readonly Card[]): boolean {
  return cards.some((c) => c.s === 'D' && c.r === '4');
}

/**
 * 列出所有合法出牌。
 * - trick 为 null 表示自己首出，长度 1..5 全枚举
 * - 否则只枚举同张数、且能压过的
 */
export function legalPlays(
  hand: readonly Card[],
  trick: Trick | null,
  opts: LegalOptions = {},
): PlayOption[] {
  const out: PlayOption[] = [];
  const lengths = trick ? [trick.pattern.len] : [1, 2, 3, 4, 5];

  for (const k of lengths) {
    if (k > hand.length) continue;
    for (const cards of combinations(hand, k)) {
      const pattern = classify(cards);
      if (!pattern) continue;
      if (opts.mustContainD4 && !hasDiamond4(cards)) continue;
      if (trick && !beats(pattern, trick.pattern)) continue;
      out.push({ pattern, cards });
    }
  }
  return out;
}

/** 按「牌力从低到高」排序，牌力相同时张数多的优先（便于甩牌） */
export function sortByPower(options: readonly PlayOption[]): PlayOption[] {
  return [...options].sort((a, b) => {
    if (a.pattern.len !== b.pattern.len) return b.pattern.len - a.pattern.len;
    return compare(a.pattern, b.pattern);
  });
}

/** 最便宜的能压过的牌 */
export function cheapestBeat(
  hand: readonly Card[],
  trick: Trick,
): PlayOption | null {
  const opts = legalPlays(hand, trick);
  if (opts.length === 0) return null;
  let best = opts[0];
  for (const o of opts) if (compare(o.pattern, best.pattern) < 0) best = o;
  return best;
}

export function describeOption(o: PlayOption): string {
  return o.cards.map(cardLabel).join(' ');
}
