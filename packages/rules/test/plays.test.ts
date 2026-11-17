import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHand } from '../src/cards.ts';
import { classify } from '../src/pattern.ts';
import type { Trick } from '../src/plays.ts';
import { cheapestBeat, legalPlays } from '../src/plays.ts';
import { canPass } from '../src/game.ts';
import { makeState } from './helpers.ts';

function trickOf(seat: number, code: string): Trick {
  const cards = parseHand(code);
  return { seat, pattern: classify(cards)!, cards };
}

test('首出枚举的所有牌型都带 ♦4', () => {
  const hand = parseHand('D4 S3 H5 C6 S7 D8 H9 C10 DJ SQ HK DA S2');
  const opts = legalPlays(hand, null, { mustContainD4: true });
  assert.ok(opts.length > 0);
  for (const o of opts) {
    assert.ok(
      o.cards.some((c) => c.s === 'D' && c.r === '4'),
      `缺少 ♦4: ${o.cards.map((c) => c.s + c.r).join(' ')}`,
    );
  }
});

test('跟单张：只能出更大的同张数牌', () => {
  const hand = parseHand('S3 H5 C8');
  const opts = legalPlays(hand, trickOf(1, 'H6'));
  const labels = opts.map((o) => o.cards[0].s + o.cards[0].r).sort();
  assert.deepEqual(labels, ['C8', 'S3']);
});

test('跟牌张数必须一致', () => {
  const hand = parseHand('S3 C8 D8 S9 C9');
  const opts = legalPlays(hand, trickOf(1, 'H6 C6'));
  assert.ok(opts.length > 0);
  for (const o of opts) assert.equal(o.cards.length, 2);
});

test('cheapestBeat 取最小能压的牌', () => {
  const hand = parseHand('S3 C8 HK');
  const best = cheapestBeat(hand, trickOf(1, 'H6'))!;
  assert.equal(best.cards[0].r, '8');
});

test('34567 不进任何五张牌型', () => {
  const hand = parseHand('C3 H4 D5 S6 C7');
  const opts = legalPlays(hand, null);
  const five = opts.filter((o) => o.cards.length === 5);
  assert.equal(five.length, 0);
  assert.ok(opts.some((o) => o.cards.length === 1), '单张仍可出');
});

test('报单：能压住必须出，压不住可以过', () => {
  const beatable = makeState(['S3', 'H6', 'C8', 'D9'], { currentSeat: 0 });
  beatable.trick = trickOf(1, 'H6');
  assert.equal(beatable.seats[0].hand.length, 1);
  assert.equal(canPass(beatable, 0), false);

  const notBeatable = makeState(['D4', 'H6', 'C8', 'D9'], { currentSeat: 0 });
  notBeatable.trick = trickOf(1, 'H6');
  assert.equal(canPass(notBeatable, 0), true);
});
