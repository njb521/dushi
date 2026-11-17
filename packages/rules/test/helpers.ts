import type { Card } from '../src/cards.ts';
import { parseHand, sortHand } from '../src/cards.ts';
import type { GameState, SeatState } from '../src/game.ts';
import { DEFAULT_RULES } from '../src/rules.ts';

/** 用字符串手牌快速造一个牌局状态，只给单元测试用 */
export function makeState(hands: readonly string[], opts: Partial<GameState> = {}): GameState {
  const seats: SeatState[] = hands.map((h, id) => ({
    id,
    name: `P${id}`,
    hand: sortHand(parseHand(h)),
    place: null,
    revealed: false,
    identityLast: false,
  }));
  return {
    phase: 'playing',
    seats,
    team: null,
    soloSeat: null,
    baiPai: false,
    surrendered: false,
    requireD4: true,
    firstPlayDone: false,
    initialLeader: 0,
    trick: null,
    currentSeat: 0,
    passed: [false, false, false, false],
    places: [],
    scores: [0, 0, 0, 0],
    round: 1,
    rules: DEFAULT_RULES,
    seed: 0,
    log: [],
    ...opts,
  };
}

/** 造一个已结束、可直接结算的状态 */
export function makeFinished(
  places: readonly number[],
  opts: Partial<GameState> = {},
): GameState {
  const seats: SeatState[] = [0, 1, 2, 3].map((id) => ({
    id,
    name: `P${id}`,
    hand: [],
    place: places.indexOf(id) + 1,
    revealed: false,
    identityLast: false,
  }));
  return {
    phase: 'settling',
    seats,
    team: null,
    soloSeat: null,
    baiPai: false,
    surrendered: false,
    requireD4: true,
    firstPlayDone: true,
    initialLeader: 0,
    trick: null,
    currentSeat: 0,
    passed: [false, false, false, false],
    places: [...places],
    scores: [0, 0, 0, 0],
    round: 1,
    rules: DEFAULT_RULES,
    seed: 0,
    log: [],
    ...opts,
  };
}

export function cardsOf(codes: string): Card[] {
  return parseHand(codes);
}
