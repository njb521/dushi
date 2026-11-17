/**
 * 牌型识别与比较。
 *
 * 牌型共 9 种：单张、对子、三张、四张、顺子、同花、三带二、四带一、同花顺。
 * 五张牌可以跨牌型比较：顺子 < 同花 < 三带二 < 四带一 < 同花顺。
 * 同花只比花色，不比点数（同花色之间视为同等大，互相压不动）。
 */

import type { Card, Rank, Suit } from './cards.ts';
import { RANK_POWER, SEQ_POWER, SUIT_POWER } from './cards.ts';

export type Cat =
  | 'single'
  | 'pair'
  | 'trips'
  | 'quad'
  | 'straight'
  | 'flush'
  | 'fullHouse'
  | 'fourPlusOne'
  | 'straightFlush';

export type Len = 1 | 2 | 3 | 4 | 5;

export interface Pattern {
  readonly len: Len;
  readonly cat: Cat;
  /** 字典序比较键，从主到次 */
  readonly key: readonly number[];
}

export const CAT_NAMES: Readonly<Record<Cat, string>> = {
  single: '单张',
  pair: '对子',
  trips: '三张',
  quad: '四张',
  straight: '顺子',
  flush: '同花',
  fullHouse: '三带二',
  fourPlusOne: '四带一',
  straightFlush: '同花顺',
};

/** 五张牌的跨牌型优先级 */
const CAT5: Readonly<Record<Cat, number>> = {
  straight: 1,
  flush: 2,
  fullHouse: 3,
  fourPlusOne: 4,
  straightFlush: 5,
  single: 0,
  pair: 0,
  trips: 0,
  quad: 0,
};

function groupByRank(cards: readonly Card[]): Map<Rank, Card[]> {
  const m = new Map<Rank, Card[]>();
  for (const c of cards) {
    const arr = m.get(c.r);
    if (arr) arr.push(c);
    else m.set(c.r, [c]);
  }
  return m;
}

function maxSuit(cards: readonly Card[]): number {
  let m = 0;
  for (const c of cards) m = Math.max(m, SUIT_POWER[c.s]);
  return m;
}

function onlySuit(cards: readonly Card[]): Suit {
  return cards[0].s;
}

/**
 * 顺子序的最高牌。非法返回 null。
 * 只有 4..A 参与，2 和 3 直接判非法。
 */
function straightTop(cards: readonly Card[]): number | null {
  if (cards.length !== 5) return null;
  const seqs: number[] = [];
  for (const c of cards) {
    const v = SEQ_POWER[c.r];
    if (v === null) return null;
    seqs.push(v);
  }
  const uniq = [...new Set(seqs)].sort((a, b) => a - b);
  if (uniq.length !== 5) return null;
  if (uniq[4] - uniq[0] !== 4) return null;
  return uniq[4];
}

function straightTopCard(cards: readonly Card[], topSeq: number): Card {
  for (const c of cards) if (SEQ_POWER[c.r] === topSeq) return c;
  throw new Error('顺子最高牌查找失败');
}

/**
 * 识别牌型。不合法返回 null。
 */
export function classify(cards: readonly Card[]): Pattern | null {
  const n = cards.length;
  if (n < 1 || n > 5) return null;

  const groups = groupByRank(cards);

  if (n === 1) {
    const c = cards[0];
    return { len: 1, cat: 'single', key: [RANK_POWER[c.r], SUIT_POWER[c.s]] };
  }

  if (n === 2 || n === 3 || n === 4) {
    if (groups.size !== 1) return null;
    const only = groups.values().next().value as Card[];
    const cat: Cat = n === 2 ? 'pair' : n === 3 ? 'trips' : 'quad';
    return { len: n as Len, cat, key: [RANK_POWER[only[0].r], maxSuit(only)] };
  }

  // n === 5
  const isFlush = new Set(cards.map((c) => c.s)).size === 1;
  const topSeq = straightTop(cards);

  if (isFlush && topSeq !== null) {
    return { len: 5, cat: 'straightFlush', key: [topSeq, SUIT_POWER[onlySuit(cards)]] };
  }
  if (topSeq !== null) {
    return { len: 5, cat: 'straight', key: [topSeq, SUIT_POWER[straightTopCard(cards, topSeq).s]] };
  }
  if (isFlush) {
    // 只看花色，不看点数
    return { len: 5, cat: 'flush', key: [SUIT_POWER[onlySuit(cards)]] };
  }

  for (const [r, grp] of groups) {
    if (grp.length === 4) {
      const kicker = cards.find((c) => c.r !== r)!;
      return {
        len: 5,
        cat: 'fourPlusOne',
        key: [RANK_POWER[r], maxSuit(grp), RANK_POWER[kicker.r], SUIT_POWER[kicker.s]],
      };
    }
  }

  if (groups.size === 2) {
    let tripRank: Rank | null = null;
    let pairRank: Rank | null = null;
    for (const [r, grp] of groups) {
      if (grp.length === 3) tripRank = r;
      else if (grp.length === 2) pairRank = r;
    }
    if (tripRank && pairRank) {
      const trip = groups.get(tripRank)!;
      const pair = groups.get(pairRank)!;
      return {
        len: 5,
        cat: 'fullHouse',
        key: [RANK_POWER[tripRank], maxSuit(trip), RANK_POWER[pairRank], maxSuit(pair)],
      };
    }
  }

  return null;
}

/**
 * 比较两个牌型。张数必须相同。
 * 返回 >0 表示 a 大，<0 表示 b 大，0 表示同等大（互相压不动）。
 */
export function compare(a: Pattern, b: Pattern): number {
  if (a.len !== b.len) throw new Error('张数不同不能比较');
  if (a.len === 5) {
    const d = CAT5[a.cat] - CAT5[b.cat];
    if (d !== 0) return Math.sign(d);
  }
  const n = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < n; i++) {
    const x = a.key[i] ?? -1;
    const y = b.key[i] ?? -1;
    if (x !== y) return Math.sign(x - y);
  }
  return 0;
}

/** a 是否严格大于 b（张数不同一律 false） */
export function beats(a: Pattern, b: Pattern): boolean {
  if (a.len !== b.len) return false;
  return compare(a, b) > 0;
}

export function patternName(p: Pattern): string {
  return CAT_NAMES[p.cat];
}
