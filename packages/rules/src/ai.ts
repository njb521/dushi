/**
 * 房间用的 AI（同时是单人模式的对手与掉线托管）。
 *
 * 目标不是"强得吓人"，而是**别做蠢事**。三条不打折的底线：
 *
 *  1. 不拿身份牌收尾（v0.3 规则：出完那一手带 ♠3/♠A → 判最后一名）
 *  2. 不压队友（队友正赢着这一圈就让过）
 *  3. 该让的让、该堵的堵：队友报单就给牌权，对手报单就往死里压
 *
 * 在此之上的"人味"：
 *  - 不为了压一张小单牌把对子/三张拆了（宁可过，留着组合后面一次甩掉）
 *  - 首出优先选"便宜且张数多"的牌型，尽快把手牌打薄
 */

import type { Card } from './cards.ts';
import { RANK_POWER, sameCard } from './cards.ts';
import type { GameState } from './game.ts';
import { canPass } from './game.ts';
import type { PlayOption } from './plays.ts';
import { legalPlays } from './plays.ts';
import { compare } from './pattern.ts';

export type BotAction = { type: 'play'; cards: Card[] } | { type: 'pass' };

/**
 * 谁是我队友。
 *
 * - 2v2：♠3 / ♠A 同侧的另一个人（只知道自己这一侧，除非身份已公开 —— AI 这里按"全知"处理，
 *   因为它本来就是服务端算出来的，不需要假装糊涂）
 * - 独食局：**独食者没有队友，另外三家临时联手**。这条很关键：独食者只要不是头游就输，
 *   所以三家是事实上的同盟 —— 不这么算，AI 会在独食局里互相压、互相拆台。
 * - 都不成立（还没判定身份）：没有队友
 */
export function matesOf(state: GameState, seat: number): number[] {
  if (state.team === null) {
    if (state.soloSeat === null) return [];
    if (seat === state.soloSeat) return [];
    return [0, 1, 2, 3].filter((i) => i !== seat && i !== state.soloSeat);
  }
  if (state.team.includes(seat)) return state.team.filter((i) => i !== seat);
  return [0, 1, 2, 3].filter((i) => !state.team.includes(i) && i !== seat);
}

const isIdentity = (c: Card): boolean => c.s === 'S' && (c.r === '3' || c.r === 'A');
const hasIdentity = (cards: readonly Card[]): boolean => cards.some(isIdentity);

/** 这一手打出去会不会把身份牌顶成"最后一张"（或直接拿它收尾）→ 新规下会被判最后一名 */
function leadsToIdentityLast(hand: readonly Card[], option: PlayOption): boolean {
  const rest = hand.filter((c) => !option.cards.some((x) => sameCard(x, c)));
  if (rest.length === 0) return hasIdentity(option.cards);
  return rest.length === 1 && isIdentity(rest[0]);
}

/** 这一手会不会拆掉手里的组合（手里同点数还有剩） */
function breaksSet(hand: readonly Card[], cards: readonly Card[]): boolean {
  const have = new Map<string, number>();
  for (const c of hand) have.set(c.r, (have.get(c.r) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const c of cards) used.set(c.r, (used.get(c.r) ?? 0) + 1);
  for (const [r, n] of used) {
    const total = have.get(r) ?? 0;
    if (total >= 2 && n < total) return true;
  }
  return false;
}

/** 只剩 1 张的对手座位（独食者眼里人人都是对手） */
function dangerousOpponents(state: GameState, seat: number): number[] {
  const partners = matesOf(state, seat);
  return [0, 1, 2, 3].filter(
    (i) => i !== seat && !partners.includes(i) && state.seats[i].hand.length === 1,
  );
}

/** 只剩 1 张的队友座位 */
function partnerAtOneCard(state: GameState, seat: number): number | undefined {
  return matesOf(state, seat).find((i) => state.seats[i].hand.length === 1);
}

/** 牌力成本：点数越小越便宜，张数越多越划算（用来挑"最不心疼"的一手） */
function cost(o: PlayOption): number {
  let c = 0;
  for (const card of o.cards) c += RANK_POWER[card.r];
  return c / o.cards.length - o.cards.length * 0.5;
}

function cheapest(opts: readonly PlayOption[]): PlayOption {
  let best = opts[0];
  for (const o of opts) if (cost(o) < cost(best)) best = o;
  return best;
}

function weakest(opts: readonly PlayOption[]): PlayOption {
  let best = opts[0];
  for (const o of opts) if (compare(o.pattern, best.pattern) < 0) best = o;
  return best;
}

function strongest(opts: readonly PlayOption[]): PlayOption {
  let best = opts[0];
  for (const o of opts) if (compare(o.pattern, best.pattern) > 0) best = o;
  return best;
}

export function chooseAction(state: GameState, seat: number): BotAction {
  return state.trick === null ? lead(state, seat) : follow(state, seat);
}

/** 首出：队友报单就递牌权，对手报单就堵门，平时挑张数多的便宜牌型 */
function lead(state: GameState, seat: number): BotAction {
  const me = state.seats[seat];
  const must = !state.firstPlayDone && state.requireD4;
  const opts = legalPlays(me.hand, null, { mustContainD4: must });
  if (opts.length === 0) return { type: 'pass' }; // 只可能因为"首出必须带 ♦4"而空

  // 先剔掉"会让身份牌变成最后一张"的选项
  const safe = opts.filter((o) => !leadsToIdentityLast(me.hand, o));
  const pool = safe.length > 0 ? safe : opts;

  // 1) 能一把出完就出完
  const finisher = pool.find((o) => o.cards.length === me.hand.length);
  if (finisher) return { type: 'play', cards: finisher.cards };

  const singles = pool.filter((o) => o.cards.length === 1);

  // 2) 队友报单：出最小的单张，给他一个能压住的机会，把牌权递过去
  if (partnerAtOneCard(state, seat) !== undefined && singles.length > 0) {
    return { type: 'play', cards: cheapest(singles).cards };
  }

  // 3) 对手报单：出最大的单张堵门（宁可亮身份，也不能让他顺手走掉）
  if (dangerousOpponents(state, seat).length > 0 && singles.length > 0) {
    return { type: 'play', cards: strongest(singles).cards };
  }

  // 4) 常规：最便宜的（长牌型成本更低，能一次甩掉更多张）
  return { type: 'play', cards: cheapest(pool).cards };
}

/** 跟牌：队友的圈让过，对手报单必压，其余情况能省就省 */
function follow(state: GameState, seat: number): BotAction {
  const me = state.seats[seat];
  const trick = state.trick!;
  const opts = legalPlays(me.hand, trick);
  if (opts.length === 0) return { type: 'pass' };

  // 1) 能一把出完（且不是拿身份牌收尾）就出完
  const finisher = opts.find((o) => o.cards.length === me.hand.length && !hasIdentity(o.cards));
  if (finisher) return { type: 'play', cards: finisher.cards };

  // 2) 队友正赢着这一圈就别压（报单被强制出牌时 canPass 为 false，只能跟）
  if (matesOf(state, seat).includes(trick.seat) && canPass(state, seat)) {
    return { type: 'pass' };
  }

  // 3) 有对手只剩 1 张：这一手能压就必须压，别再省牌
  if (dangerousOpponents(state, seat).length > 0) {
    return { type: 'play', cards: weakest(opts).cards };
  }

  // 4) 单张的圈：不拆对子/三张去压小牌 —— 宁可过，把组合留到后面一次甩
  if (trick.pattern.len === 1) {
    const clean = opts.filter((o) => !breaksSet(me.hand, o.cards));
    if (clean.length > 0) return { type: 'play', cards: weakest(clean).cards };
    // 拆不出干净的牌就不压；但报单被强制出牌时没有选择
    return canPass(state, seat) ? { type: 'pass' } : { type: 'play', cards: weakest(opts).cards };
  }

  // 5) 多张的圈：按最小的能压住的打
  return { type: 'play', cards: weakest(opts).cards };
}
