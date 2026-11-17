/**
 * M0 用的简单 AI：够跑通对局、够支撑随机对局测试，不追求强度。
 *
 * v0.3 起有个必须遵守的新规：出完的那一手带 ♠3 / ♠A → 直接判最后一名（§2.15）。
 * 所以这里多了个"别把身份牌留成最后一张"的过滤 —— 否则 AI 会稳定自杀：
 * ♠3 是最大单张，按"打便宜的牌"的贪心策略天然会把它留到最后。
 */

import type { Card } from './cards.ts';
import { RANK_POWER, sameCard } from './cards.ts';
import type { GameState } from './game.ts';
import { canPass } from './game.ts';
import type { PlayOption } from './plays.ts';
import { legalPlays } from './plays.ts';
import { compare } from './pattern.ts';

export type BotAction = { type: 'play'; cards: Card[] } | { type: 'pass' };

export function matesOf(state: GameState, seat: number): number[] {
  if (state.team === null) return [];
  if (state.team.includes(seat)) return state.team.filter((i) => i !== seat);
  return [0, 1, 2, 3].filter((i) => !state.team.includes(i) && i !== seat);
}

const isIdentity = (c: Card): boolean => c.s === 'S' && (c.r === '3' || c.r === 'A');
const hasIdentity = (cards: readonly Card[]): boolean => cards.some(isIdentity);

/**
 * 这一手打出去会不会把身份牌顶成"最后一张"（或直接拿它收尾）。
 * 是 → 按新规会被判最后一名，能避就避。
 */
function leadsToIdentityLast(hand: readonly Card[], option: PlayOption): boolean {
  const rest = hand.filter((c) => !option.cards.some((x) => sameCard(x, c)));
  if (rest.length === 0) return hasIdentity(option.cards);
  return rest.length === 1 && isIdentity(rest[0]);
}

/** 牌力成本：点数越小越便宜，张数越多越划算 */
function cost(o: PlayOption): number {
  let c = 0;
  for (const card of o.cards) c += RANK_POWER[card.r];
  return c / o.cards.length - o.cards.length * 0.5;
}

export function chooseAction(state: GameState, seat: number): BotAction {
  const me = state.seats[seat];
  const trick = state.trick;

  if (trick === null) {
    const must = !state.firstPlayDone && state.requireD4;
    const opts = legalPlays(me.hand, null, { mustContainD4: must });
    if (opts.length === 0) return { type: 'pass' }; // 理论上不会发生
    const safe = opts.filter((o) => !leadsToIdentityLast(me.hand, o));
    const pool = safe.length > 0 ? safe : opts;
    let best = pool[0];
    for (const o of pool) if (cost(o) < cost(best)) best = o;
    return { type: 'play', cards: best.cards };
  }

  // 队友的牌面：让过（报单必出时除外）
  if (matesOf(state, seat).includes(trick.seat) && canPass(state, seat)) {
    return { type: 'pass' };
  }

  const opts = legalPlays(me.hand, trick);
  if (opts.length === 0) return { type: 'pass' };

  // 能一把出完就出完 —— 但别拿身份牌收尾（否则赢了也判负）
  const finishers = opts.filter((o) => o.cards.length === me.hand.length);
  const cleanFinish = finishers.find((o) => !hasIdentity(o.cards));
  if (cleanFinish) return { type: 'play', cards: cleanFinish.cards };

  const safe = opts.filter((o) => !leadsToIdentityLast(me.hand, o));
  const pool = safe.length > 0 ? safe : finishers.length > 0 ? finishers : opts;
  let best = pool[0];
  for (const o of pool) if (compare(o.pattern, best.pattern) < 0) best = o;
  return { type: 'play', cards: best.cards };
}
