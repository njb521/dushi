/**
 * 随机对局模拟：不是 AI，是"随机合法走子"，用来压测规则引擎的不变量。
 */

import { mulberry32 } from './cards.ts';
import type { Card } from './cards.ts';
import type { GameState } from './game.ts';
import { canPass, createGame, declare, pass, play, settle } from './game.ts';
import { legalPlays } from './plays.ts';

export interface SimStats {
  games: number;
  soloGames: number;
  soloWins: number;
  baiPaiGames: number;
  surrenders: number;
  maxSteps: number;
  steps: number;
  deltas: number;
}

type Action = { type: 'play'; cards: Card[] } | { type: 'pass' };

function randomAction(state: GameState, seat: number, rng: () => number): Action {
  const me = state.seats[seat];

  if (state.trick === null) {
    const must = !state.firstPlayDone && state.requireD4;
    const opts = legalPlays(me.hand, null, { mustContainD4: must });
    if (opts.length === 0) throw new Error('首出无牌可出');
    return { type: 'play', cards: opts[Math.floor(rng() * opts.length)].cards };
  }

  if (canPass(state, seat) && rng() < 0.35) return { type: 'pass' };
  const opts = legalPlays(me.hand, state.trick);
  if (opts.length === 0) return { type: 'pass' };
  return { type: 'play', cards: opts[Math.floor(rng() * opts.length)].cards };
}

export interface SimOptions {
  readonly baseSeed?: number;
  /** 摆牌概率，默认 0.3 */
  readonly baiPaiRate?: number;
  /** 投降概率，默认 0.02 */
  readonly surrenderRate?: number;
  /** 每局结束后回调，用于额外断言 */
  readonly onSettled?: (state: GameState, deltas: readonly number[]) => void;
  /** 每步回调，用于额外断言 */
  readonly onStep?: (state: GameState) => void;
}

export function simulate(games: number, options: SimOptions = {}): SimStats {
  const baseSeed = options.baseSeed ?? 1;
  const baiPaiRate = options.baiPaiRate ?? 0.3;
  const surrenderRate = options.surrenderRate ?? 0.02;

  const stats: SimStats = {
    games: 0,
    soloGames: 0,
    soloWins: 0,
    baiPaiGames: 0,
    surrenders: 0,
    maxSteps: 0,
    steps: 0,
    deltas: 0,
  };

  for (let g = 0; g < games; g++) {
    const seed = (baseSeed + g * 7919) >>> 0;
    const rng = mulberry32(seed);
    const state = createGame(['A', 'B', 'C', 'D'], seed);

    if (state.phase === 'declaring') {
      const r = rng();
      if (r < surrenderRate) {
        declare(state, 'surrender');
        stats.surrenders++;
      } else if (r < surrenderRate + baiPaiRate) {
        declare(state, 'baiPai');
        stats.baiPaiGames++;
      } else {
        declare(state, 'none');
      }
    }

    let played = 0;
    let steps = 0;
    while (state.phase === 'playing') {
      if (++steps > 2000) throw new Error(`seed ${seed}: 对局不收敛`);

      const totalInHands = state.seats.reduce((a, s) => a + s.hand.length, 0);
      if (totalInHands + played !== 52) throw new Error(`seed ${seed}: 牌数不守恒`);

      const seat = state.currentSeat;
      const action = randomAction(state, seat, rng);

      if (action.type === 'play') {
        const before = state.seats[seat].hand.length;
        play(state, seat, action.cards);
        played += action.cards.length;
        if (state.seats[seat].hand.length !== before - action.cards.length) {
          throw new Error(`seed ${seed}: 手牌扣除异常`);
        }
        if (state.trick!.pattern.len !== state.trick!.cards.length) {
          throw new Error(`seed ${seed}: 牌型张数不一致`);
        }
      } else {
        pass(state, seat);
      }

      options.onStep?.(state);

      if (new Set(state.places).size !== state.places.length) {
        throw new Error(`seed ${seed}: 名次重复`);
      }
    }

    if (state.phase !== 'settling') throw new Error(`seed ${seed}: 对局未结束`);
    if (!state.surrendered && state.places.length !== 4) {
      throw new Error(`seed ${seed}: 名次没排完`);
    }

    const r = settle(state);
    const total = r.deltas.reduce((a, b) => a + b, 0);
    if (total !== 0) throw new Error(`seed ${seed}: 结算非零和 ${total}`);

    options.onSettled?.(state, r.deltas);

    if (state.soloSeat !== null) {
      stats.soloGames++;
      if (state.seats[state.soloSeat].place === 1) stats.soloWins++;
    }
    stats.games++;
    stats.steps += steps;
    stats.maxSteps = Math.max(stats.maxSteps, steps);
    stats.deltas = total;
  }

  return stats;
}
