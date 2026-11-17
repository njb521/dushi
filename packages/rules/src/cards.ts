/**
 * 牌的基本定义与工具。
 *
 * 两条容易搞混的序：
 *  - RANK_POWER：单张/对子/三张… 的点数大小。3 最大，4 最小。
 *  - SEQ_POWER ：顺子的点数大小。只有 4..A 参与，2 和 3 为 null（不能进顺子）。
 */

export type Suit = 'S' | 'H' | 'C' | 'D';
export type Rank = '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A' | '2';

export interface Card {
  readonly s: Suit;
  readonly r: Rank;
}

/** 花色由大到小 */
export const SUITS: readonly Suit[] = ['S', 'H', 'C', 'D'];
/** 点数由小到大（数组下标即牌序，仅用于生成牌堆） */
export const RANKS: readonly Rank[] = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

/** 点数大小：3 > 2 > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 */
export const RANK_POWER: Readonly<Record<Rank, number>> = {
  '3': 13, '2': 12, 'A': 11, 'K': 10, 'Q': 9, 'J': 8, '10': 7, '9': 6, '8': 5, '7': 4, '6': 3, '5': 2, '4': 1,
};

/** 花色大小：♠ > ♥ > ♣ > ♦ */
export const SUIT_POWER: Readonly<Record<Suit, number>> = { S: 4, H: 3, C: 2, D: 1 };

/** 顺子序：只有 4..A，2 与 3 不参与顺子 */
export const SEQ_POWER: Readonly<Record<Rank, number | null>> = {
  '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, 'J': 8, 'Q': 9, 'K': 10, 'A': 11,
  '3': null, '2': null,
};

export const SUIT_SYMBOL: Readonly<Record<Suit, string>> = { S: '♠', H: '♥', C: '♣', D: '♦' };

export function card(s: Suit, r: Rank): Card {
  return { s, r };
}

/** 52 张牌 */
export function deck(): Card[] {
  const out: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) out.push({ s, r });
  return out;
}

export function cardId(c: Card): number {
  return SUITS.indexOf(c.s) * 13 + RANKS.indexOf(c.r);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.s === b.s && a.r === b.r;
}

/** '♠3' */
export function cardLabel(c: Card): string {
  return `${SUIT_SYMBOL[c.s]}${c.r}`;
}

export function handLabel(cards: readonly Card[]): string {
  return cards.map(cardLabel).join(' ');
}

/** 'S3' / 'H10' / 'D4' → Card */
export function parseCard(code: string): Card {
  const m = /^([SHCD])(10|[3-9JQKA2])$/.exec(code.trim().toUpperCase());
  if (!m) throw new Error(`无法解析的牌: ${code}`);
  return { s: m[1] as Suit, r: m[2] as Rank };
}

/** 'S3 H3 D4' → Card[] */
export function parseHand(codes: string): Card[] {
  return codes.trim().split(/\s+/).filter(Boolean).map(parseCard);
}

/** 手牌排序：点数降序，同点数花色降序 */
export function sortHand(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => RANK_POWER[b.r] - RANK_POWER[a.r] || SUIT_POWER[b.s] - SUIT_POWER[a.s]);
}

/** 可复现的伪随机数生成器（测试 / 回放用） */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
