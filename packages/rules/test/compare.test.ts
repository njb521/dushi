import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHand } from '../src/cards.ts';
import { classify, compare, beats } from '../src/pattern.ts';

const p = (s: string) => classify(parseHand(s))!;

test('同花只比花色：烂点数的 ♠ 同花压过 ♥ 的大牌同花', () => {
  const spade = p('S4 S6 S7 SJ SK');
  const heart = p('HA HK HQ HJ H9');
  assert.ok(compare(spade, heart) > 0);
  assert.ok(beats(spade, heart));
});

test('同花色的两张同花互相压不动', () => {
  const a = p('S4 S6 S7 SJ SK');
  const b = p('S2 S5 S8 S9 SQ');
  assert.equal(compare(a, b), 0);
  assert.equal(beats(a, b), false);
  assert.equal(beats(b, a), false);
});

test('顺子按最高牌比较，同最高牌比花色', () => {
  assert.ok(compare(p('C4 H5 D6 S7 C8'), p('C5 H6 D7 S8 C9')) < 0);
  // 都是 4-8，比最高牌 8 的花色
  assert.ok(compare(p('S8 H7 D6 C5 C4'), p('H8 S7 D6 C5 C4')) > 0);
});

test('五张跨牌型：顺子 < 同花 < 三带二 < 四带一 < 同花顺', () => {
  const straight = p('C4 H5 D6 S7 C8');
  const flush = p('D4 D6 D7 DJ DK');
  const fullHouse = p('C9 S9 H9 S5 D5');
  const fourPlus = p('C8 S8 H8 D8 SK');
  const sf = p('H4 H5 H6 H7 H8');

  assert.ok(compare(straight, flush) < 0);
  assert.ok(compare(flush, fullHouse) < 0);
  assert.ok(compare(fullHouse, fourPlus) < 0);
  assert.ok(compare(fourPlus, sf) < 0);
  assert.ok(compare(straight, sf) < 0);
});

test('同型比点数，同点数比花色', () => {
  assert.ok(compare(p('SA HA'), p('SK HK')) > 0);
  assert.ok(compare(p('SA HA'), p('HA CA')) > 0);
  assert.ok(compare(p('S3 H3'), p('S2 H2')) > 0);
  assert.ok(compare(p('D4'), p('C5')) < 0);
});

test('张数不同一律不可比', () => {
  assert.equal(beats(p('S3'), p('S4 S5 S6 S7 S8')), false);
  assert.throws(() => compare(p('S3'), p('S4 H4')));
});

test('比较的反对称性', () => {
  const a = p('C9 S9 H9 S5 D5');
  const b = p('C8 S8 H8 S7 D7');
  assert.equal(Math.sign(compare(a, b)), -Math.sign(compare(b, a)));
  assert.ok(beats(a, b));
  assert.ok(!beats(b, a));
});
