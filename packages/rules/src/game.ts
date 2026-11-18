/**
 * 牌局状态机：发牌 → 独食宣告 → 出牌 → 结算。
 *
 * 设计约定：
 *  - 状态是可变对象（服务端持有唯一真值），需要快照时用 structuredClone。
 *  - 非法操作一律通过 validatePlay / canPass 预先判断，apply 系列函数在非法时抛错。
 */

import type { Card, Rank, Suit } from './cards.ts';
import { cardLabel, deck, mulberry32, sameCard, shuffle, sortHand } from './cards.ts';
import type { Pattern } from './pattern.ts';
import { beats, classify, patternName } from './pattern.ts';
import type { Trick } from './plays.ts';
import type { RuleSet } from './rules.ts';
import { DEFAULT_RULES } from './rules.ts';

export type Phase = 'declaring' | 'playing' | 'settling';
export type DeclareChoice = 'none' | 'baiPai' | 'surrender';

export const PLACE_NAMES = ['', '头游', '二游', '三游', '四游'] as const;

export interface SeatState {
  readonly id: number;
  readonly name: string;
  hand: Card[];
  /** 1..4，未出完为 null */
  place: number | null;
  /** 身份是否已公开（打出过 ♠3 或 ♠A） */
  revealed: boolean;
  /**
   * 是否是"出完手牌的那一手带着身份牌"（♠3 / ♠A）。
   * 规则：这种打法直接判最后一名，无论他是独食者还是队伍里的人 —— 见 §2.15。
   */
  identityLast: boolean;
}

export interface GameState {
  phase: Phase;
  seats: SeatState[];
  /** 2v2 时 ♠3 / ♠A 的持有者座位；独食局为 null */
  team: [number, number] | null;
  soloSeat: number | null;
  baiPai: boolean;
  surrendered: boolean;
  /** 首出是否还必须带 ♦4 */
  requireD4: boolean;
  firstPlayDone: boolean;
  /** 首发牌者（♦4 持有者），摆牌时可能被独食者顶替 */
  initialLeader: number;
  trick: Trick | null;
  currentSeat: number;
  passed: boolean[];
  places: number[];
  scores: number[];
  round: number;
  rules: RuleSet;
  seed: number;
  log: string[];
}

export interface Validation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly pattern?: Pattern;
}

function fail(reason: string): Validation {
  return { ok: false, reason };
}

function seatOf(state: GameState, suit: Suit, rank: Rank): number {
  return state.seats.findIndex((s) => s.hand.some((c) => c.s === suit && c.r === rank));
}

export function createGame(
  names: readonly string[],
  seed: number,
  rules: RuleSet = DEFAULT_RULES,
  round = 1,
): GameState {
  if (names.length !== 4) throw new Error('独食必须是 4 人');
  const rng = mulberry32(seed);
  const cards = shuffle(deck(), rng);

  const seats: SeatState[] = names.map((name, id) => ({
    id,
    name,
    hand: sortHand(cards.slice(id * 13, (id + 1) * 13)),
    place: null,
    revealed: false,
    identityLast: false,
  }));

  const state: GameState = {
    phase: 'playing',
    seats,
    team: null,
    soloSeat: null,
    baiPai: false,
    surrendered: false,
    requireD4: rules.leadMustContainDiamond4,
    firstPlayDone: false,
    initialLeader: 0,
    trick: null,
    currentSeat: 0,
    passed: [false, false, false, false],
    places: [],
    scores: [0, 0, 0, 0],
    round,
    rules,
    seed,
    log: [],
  };

  const s3 = seatOf(state, 'S', '3');
  const sa = seatOf(state, 'S', 'A');
  const d4 = seatOf(state, 'D', '4');
  if (s3 < 0 || sa < 0 || d4 < 0) throw new Error('发牌异常：关键牌缺失');

  state.initialLeader = d4;
  state.currentSeat = d4;

  if (s3 === sa) {
    state.soloSeat = s3;
    state.phase = 'declaring';
    state.currentSeat = s3;
  } else {
    state.team = [Math.min(s3, sa), Math.max(s3, sa)];
  }
  return state;
}

/** 独食宣告。返回首出者。 */
export function declare(state: GameState, choice: DeclareChoice): void {
  if (state.phase !== 'declaring') throw new Error('当前不是宣告阶段');
  if (state.soloSeat === null) throw new Error('本局没有独食者');
  if (choice === 'surrender') {
    if (!state.rules.allowSurrender) throw new Error('本规则不允许投降');
    state.surrendered = true;
    state.phase = 'settling';
    state.log.push(`${state.seats[state.soloSeat].name} 投降`);
    return;
  }

  state.baiPai = choice === 'baiPai';
  if (state.baiPai) state.seats[state.soloSeat].revealed = true;

  const soloLeads = state.baiPai && state.rules.baiPaiLeadsFirst;
  state.requireD4 = state.rules.leadMustContainDiamond4 && !soloLeads;
  state.phase = 'playing';
  state.currentSeat = soloLeads ? state.soloSeat : state.initialLeader;
  state.trick = null;
  state.passed = [false, false, false, false];
  // "不表态"绝不能写日志：这份日志是三个人都能看到的公共信息，
  // 一旦写上"某某不表态"，等于开局第一秒就把暗独食者点名了。
  // 摆牌本来就是公开行为（手牌都亮出来了），只有它该留痕。
  if (state.baiPai) {
    state.log.push(`${state.seats[state.soloSeat].name} 摆牌，手牌公开`);
  }
}

function handContainsAll(hand: readonly Card[], cards: readonly Card[]): boolean {
  const pool = [...hand];
  for (const c of cards) {
    const i = pool.findIndex((h) => sameCard(h, c));
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
}

function explainInvalid(cards: readonly Card[]): string {
  if (cards.length === 5) {
    const ranks = new Set(cards.map((c) => c.r));
    if (ranks.size === 5) {
      if (cards.some((c) => c.r === '3' || c.r === '2')) {
        return '牌型不合法：顺子不能包含 2 或 3';
      }
      return '牌型不合法：这五张牌不连续（顺子只有 4-8 到 10-A）';
    }
    return '牌型不合法：五张牌不符合任何牌型';
  }
  return '牌型不合法';
}

export function validatePlay(state: GameState, seat: number, cards: readonly Card[]): Validation {
  if (state.phase !== 'playing') return fail('当前不是出牌阶段');
  if (state.currentSeat !== seat) return fail('还没轮到你出牌');
  if (cards.length === 0) return fail('没有选牌');

  const me = state.seats[seat];
  if (!handContainsAll(me.hand, cards)) return fail('手牌里没有这些牌');

  const pattern = classify(cards);
  if (!pattern) return fail(explainInvalid(cards));

  if (state.rules.tripsOnlyWhenThreeLeft && pattern.cat === 'trips' && me.hand.length !== 3) {
    return fail('本规则下三张只能在剩 3 张时打出');
  }

  if (state.trick === null) {
    if (!state.firstPlayDone && state.requireD4 && !cards.some((c) => c.s === 'D' && c.r === '4')) {
      return fail('首出必须包含 ♦4');
    }
  } else {
    if (pattern.len !== state.trick.pattern.len) {
      return fail(`必须出 ${state.trick.pattern.len} 张`);
    }
    if (!beats(pattern, state.trick.pattern)) {
      return fail(`压不过上一手（${patternName(state.trick.pattern)}）`);
    }
  }
  return { ok: true, pattern };
}

export function canPass(state: GameState, seat: number): boolean {
  if (state.phase !== 'playing' || state.trick === null) return false;
  if (!state.rules.mustPlayWhenReporting) return true;
  const me = state.seats[seat];
  if (me.hand.length !== 1) return true;
  if (state.trick.pattern.len !== 1) return true;
  const single = classify(me.hand);
  return !(single && beats(single, state.trick.pattern));
}

function nextActive(state: GameState, from: number): number {
  for (let i = 1; i <= 4; i++) {
    const s = (from + i) % 4;
    if (state.seats[s].hand.length > 0) return s;
  }
  return from;
}

function trickClosed(state: GameState): boolean {
  const owner = state.trick!.seat;
  const active = state.seats.filter((s) => s.hand.length > 0);
  if (active.length === 0) return true;
  return active.every((s) => s.id === owner || state.passed[s.id]);
}

function openNewTrick(state: GameState): void {
  const owner = state.trick!.seat;
  state.trick = null;
  state.passed = [false, false, false, false];
  state.currentSeat = state.seats[owner].hand.length > 0 ? owner : nextActive(state, owner);
}

export function isOver(state: GameState): boolean {
  if (state.places.length >= 4) return true;
  if (state.soloSeat !== null) {
    return state.seats[state.soloSeat].place !== null || state.places.length >= 3;
  }
  const team = state.team!;
  const others = [0, 1, 2, 3].filter((i) => !team.includes(i));
  const allPlaced = (ids: readonly number[]) => ids.every((id) => state.seats[id].place !== null);
  return allPlaced(team) || allPlaced(others);
}

function finish(state: GameState): void {
  const rest = state.seats
    .filter((s) => s.place === null)
    .sort((a, b) => a.hand.length - b.hand.length || a.id - b.id);
  for (const s of rest) {
    s.place = state.places.length + 1;
    state.places.push(s.id);
  }
  applyIdentityPenalty(state);
  state.phase = 'settling';
}

const isIdentityCard = (c: Card): boolean => c.s === 'S' && (c.r === '3' || c.r === 'A');

/**
 * 身份牌留到最后 → 判最后一名（规则 §2.15）。
 *
 * 这条规则的用意：♠3/♠A 本来是"暗队友"的凭据，谁把它捂到最后一张才甩出来，
 * 就等于把牌桌当成了信息战 —— 而且往往还能靠它（♠3 是最大的单张）抢到出完。
 * 所以不管他是独食者还是队伍里的人，出完的那一手带身份牌，一律挪到末位。
 *
 * 多个玩家同时犯：按他们**出完的先后**占住末尾几个名次，先出完的排前面。
 * 这样 places 永远是 1..4 的排列，计分不会因此错位。
 */
function applyIdentityPenalty(state: GameState): void {
  const offenders = state.places.filter((id) => state.seats[id].identityLast);
  if (offenders.length === 0) return;
  const clean = state.places.filter((id) => !state.seats[id].identityLast);
  state.places = [...clean, ...offenders];
  state.places.forEach((id, i) => {
    state.seats[id].place = i + 1;
  });
  state.log.push(`身份牌留到最后：${offenders.map((id) => state.seats[id].name).join('、')} 判最后一名`);
}

export function play(state: GameState, seat: number, cards: readonly Card[]): Pattern {
  const v = validatePlay(state, seat, cards);
  if (!v.ok) throw new Error(v.reason);
  const pattern = v.pattern!;

  const me = state.seats[seat];
  const hand = [...me.hand];
  for (const c of cards) {
    const i = hand.findIndex((h) => sameCard(h, c));
    hand.splice(i, 1);
  }
  me.hand = sortHand(hand);

  state.trick = { seat, pattern, cards: [...cards] };
  state.passed = [false, false, false, false];
  state.firstPlayDone = true;

  if (cards.some((c) => c.s === 'S' && (c.r === '3' || c.r === 'A'))) me.revealed = true;

  state.log.push(`${me.name} 出 ${cards.map(cardLabel).join(' ')}（${patternName(pattern)}）`);

  if (me.hand.length === 0) {
    // 出完的这一手带身份牌 → 结算时判最后一名（§2.15）
    me.identityLast = cards.some(isIdentityCard);
    me.place = state.places.length + 1;
    state.places.push(seat);
    state.log.push(
      me.identityLast
        ? `${me.name} 出完，但身份牌留到最后 —— 判最后一名`
        : `${me.name} 出完，${PLACE_NAMES[me.place]}`,
    );
  }

  if (isOver(state)) {
    finish(state);
    return pattern;
  }
  state.currentSeat = nextActive(state, seat);
  return pattern;
}

export function pass(state: GameState, seat: number): void {
  if (state.phase !== 'playing') throw new Error('当前不是出牌阶段');
  if (state.currentSeat !== seat) throw new Error('还没轮到你');
  if (state.trick === null) throw new Error('首出不能不出');
  if (!canPass(state, seat)) throw new Error('报单必须出牌，不能过');

  state.passed[seat] = true;
  state.log.push(`${state.seats[seat].name} 不出`);

  if (trickClosed(state)) openNewTrick(state);
  else state.currentSeat = nextActive(state, seat);
}

export interface SettleResult {
  deltas: number[];
  totals: number[];
  reason: string;
  places: number[];
  soloSeat: number | null;
  baiPai: boolean;
}

/**
 * 独食者按名次的基础分（v0.3 定稿）。
 *
 *   头游 +12（三家各 −4）
 *   二游  −6（三家各 +2）
 *   三游 −12（三家各 +4）
 *   四游 −12（三家各 +4）
 *
 * 只有头游是正值，所以"独食必须头游才算赢"在新表下自动成立。
 * 全部零和：独食者的分由另外三家均摊。摆牌时再乘 baiPaiMultiplier。
 */
export const SOLO_SCORES: Record<number, number> = { 1: 12, 2: -6, 3: -12, 4: -12 };

/** 结算（纯函数，不修改 state.scores） */
export function settle(state: GameState): SettleResult {
  const deltas = [0, 0, 0, 0];
  let reason = '';

  if (state.surrendered) {
    // 投降按四游算（不是便宜认输）：想认输也得付同样的代价
    const solo = state.soloSeat!;
    deltas[solo] = SOLO_SCORES[4];
    for (let i = 0; i < 4; i++) if (i !== solo) deltas[i] = -SOLO_SCORES[4] / 3;
    reason = '独食者投降';
  } else if (state.soloSeat !== null) {
    const solo = state.soloSeat;
    const p = state.seats[solo].place ?? 4;
    // 摆牌 = 该名次分数 × 倍数。二游本来就是负分，所以"摆牌必须头游"自动成立
    const base = SOLO_SCORES[p] ?? SOLO_SCORES[4];
    const v = state.baiPai ? base * state.rules.baiPaiMultiplier : base;
    reason = state.baiPai ? `摆牌独食${PLACE_NAMES[p]}` : `独食${PLACE_NAMES[p]}`;
    deltas[solo] = v;
    const each = -v / 3;
    for (let i = 0; i < 4; i++) if (i !== solo) deltas[i] = each;
  } else {
    const team = state.team!;
    const winner = state.places[0];
    const onTeam = team.includes(winner);
    const mateId = onTeam
      ? team[0] === winner
        ? team[1]
        : team[0]
      : [0, 1, 2, 3].find((id) => !team.includes(id) && id !== winner)!;
    const matePlace = state.seats[mateId].place ?? 4;
    const v = matePlace === 2 ? 4 : matePlace === 3 ? 2 : 0;
    const winTeam = onTeam ? [...team] : [0, 1, 2, 3].filter((i) => !team.includes(i));
    for (const id of winTeam) deltas[id] = v;
    for (const id of [0, 1, 2, 3].filter((i) => !winTeam.includes(i))) deltas[id] = -v;
    reason = matePlace === 2 ? '双上' : matePlace === 3 ? '一三' : '一四';
  }

  return {
    deltas: deltas.map((d) => (d === 0 ? 0 : d)),
    totals: state.scores.map((s, i) => s + deltas[i]),
    reason,
    places: [...state.places],
    soloSeat: state.soloSeat,
    baiPai: state.baiPai,
  };
}

export function applyScores(state: GameState, deltas: readonly number[]): void {
  for (let i = 0; i < 4; i++) state.scores[i] += deltas[i];
}

export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}
