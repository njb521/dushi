/**
 * 房间用的 AI（同时是单人模式的对手与掉线托管）。
 *
 * 目标不是"强得吓人"，而是**别做蠢事，也别磨洋工**。三条不打折的底线：
 *
 *  1. 不拿身份牌单张收尾（§2.15：最后一张单出的牌是 ♠3/♠A → 判最后一名）
 *  2. 不压队友（队友正赢着这一圈就让过）
 *  3. 该让的让、该堵的堵：队友报单就给牌权，对手报单就往死里压
 *
 * 跑牌游戏的核心是"把牌打薄"，所以首出的第一目标是**一次甩掉更多张**，
 * 便宜只是第二目标；跟牌时才反过来，能不拆组合就不拆 —— 但残局例外。
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

/**
 * 这一手会不会把自己送进"判末位"（§2.15 v0.3.1：只看最后一张单出的牌）。
 *
 *  - 这一手直接出完，且是单张身份牌 → 判末位
 *  - 打完只剩一张，且那张是身份牌 → 下一手只能单出它，等于预约判末位
 *
 * 注意：把 ♠3 塞进同花/三带二里一起出掉**不算** —— 那本来就是正解。
 */
function leadsToIdentityLast(hand: readonly Card[], option: PlayOption): boolean {
  const rest = hand.filter((c) => !option.cards.some((x) => sameCard(x, c)));
  if (rest.length === 0) return option.cards.length === 1 && isIdentity(option.cards[0]);
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

/**
 * 首出打分：**张数优先，其次便宜**。
 *
 * 以前这里跟跟牌共用 `cost`，结果比的是"平均牌力"，AI 永远挑最小的单张出去 ——
 * 13 张牌要出十几手才空，看着就像"攥着一把牌不肯出"。跑牌游戏里，
 * 一次甩 5 张（顺子/三带二）永远比出 5 次单张值钱，因为每次出牌都要重新抢牌权。
 *
 * 拆组合要扣分：手里一对 4 只出一张，剩下那张 4 以后只能单出，是净损失。
 */
function leadScore(hand: readonly Card[], o: PlayOption): number {
  const avg = o.cards.reduce((s, c) => s + RANK_POWER[c.r], 0) / o.cards.length;
  let s = o.cards.length * 3 - avg;
  if (breaksSet(hand, o.cards)) s -= 5;
  return s;
}

function bestLead(hand: readonly Card[], opts: readonly PlayOption[]): PlayOption {
  let best = opts[0];
  for (const o of opts) if (leadScore(hand, o) > leadScore(hand, best)) best = o;
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

  // 4) 常规：一次甩掉更多张（顺子/三带二优先），拆组合扣分
  return { type: 'play', cards: bestLead(me.hand, pool).cards };
}

/** 跟牌：队友的圈让过，对手报单必压，其余情况能省就省 */
function follow(state: GameState, seat: number): BotAction {
  const me = state.seats[seat];
  const trick = state.trick!;
  const opts = legalPlays(me.hand, trick);
  if (opts.length === 0) return { type: 'pass' };

  // 1) 能一把出完就出完（唯一例外：只剩一张身份牌，单出它会被判末位）
  const finisher = opts.find(
    (o) => o.cards.length === me.hand.length && !(o.cards.length === 1 && hasIdentity(o.cards)),
  );
  if (finisher) return { type: 'play', cards: finisher.cards };

  // 2) 队友正赢着这一圈就别压（报单被强制出牌时 canPass 为 false，只能跟）
  if (matesOf(state, seat).includes(trick.seat) && canPass(state, seat)) {
    return { type: 'pass' };
  }

  // 3) 有对手只剩 1 张：这一手能压就必须压，别再省牌
  if (dangerousOpponents(state, seat).length > 0) {
    return { type: 'play', cards: weakest(opts).cards };
  }

  // 4) 打完会不会只剩一张身份牌？那等于预约一个 −12，能不打就不打
  const safe = opts.filter((o) => !leadsToIdentityLast(me.hand, o));
  const pool = safe.length > 0 ? safe : canPass(state, seat) ? [] : opts;
  if (pool.length === 0) return { type: 'pass' };

  // 5) 单张的圈：优先用"不用拆组合"的牌去压
  if (trick.pattern.len === 1) {
    const clean = pool.filter((o) => !breaksSet(me.hand, o.cards));
    if (clean.length > 0) return { type: 'play', cards: weakest(clean).cards };

    // 只有拆对子/三张才压得住的时候：以前一律让过，结果牌越攥越多。
    // 现在看两种情况必须抢：手里没剩几张了（残局牌权比结构值钱），
    // 或者对面这手已经很大（K 以上，让过去基本等于白送一圈）。
    const endgame = me.hand.length <= 7;
    const bigCard = (trick.pattern.key[0] ?? 0) >= RANK_POWER['K'];
    if (endgame || bigCard || !canPass(state, seat)) {
      return { type: 'play', cards: weakest(pool).cards };
    }
    return { type: 'pass' };
  }

  // 6) 多张的圈：按最小的能压住的打
  return { type: 'play', cards: weakest(pool).cards };
}
