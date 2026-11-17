/**
 * M0 用的简单 AI：够跑通对局、够支撑随机对局测试，不追求强度。
 */

import type { Card } from './cards.ts';
import { RANK_POWER } from './cards.ts';
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
    let best = opts[0];
    for (const o of opts) if (cost(o) < cost(best)) best = o;
    return { type: 'play', cards: best.cards };
  }

  // 队友的牌面：让过（报单必出时除外）
  if (matesOf(state, seat).includes(trick.seat) && canPass(state, seat)) {
    return { type: 'pass' };
  }

  const opts = legalPlays(me.hand, trick);
  if (opts.length === 0) return { type: 'pass' };

  // 能一把出完就出完
  const finishMove = opts.find((o) => o.cards.length === me.hand.length);
  if (finishMove) return { type: 'play', cards: finishMove.cards };

  let best = opts[0];
  for (const o of opts) if (compare(o.pattern, best.pattern) < 0) best = o;
  return { type: 'play', cards: best.cards };
}
