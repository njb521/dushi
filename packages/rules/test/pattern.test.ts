import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHand } from '../src/cards.ts';
import { classify, CAT_NAMES } from '../src/pattern.ts';

const p = (s: string) => classify(parseHand(s));

test('单张：♠3 最大、♦4 最小', () => {
  const s3 = p('S3')!;
  const d4 = p('D4')!;
  assert.equal(s3.cat, 'single');
  assert.deepEqual([...s3.key], [13, 4]);
  assert.deepEqual([...d4.key], [1, 1]);
});

test('对子 / 三张 / 四张：取同点数牌里最大的花色', () => {
  assert.equal(p('SA HA')!.cat, 'pair');
  assert.deepEqual([...p('SA HA')!.key], [11, 4]);
  assert.deepEqual([...p('HA CA')!.key], [11, 3]);

  assert.equal(p('C9 S9 H9')!.cat, 'trips');
  assert.deepEqual([...p('C9 S9 H9')!.key], [6, 4]);

  assert.equal(p('C9 S9 H9 D9')!.cat, 'quad');
  assert.deepEqual([...p('C9 S9 H9 D9')!.key], [6, 4]);
});

test('顺子：4-8 最小，10-A 最大，只认 7 种', () => {
  assert.deepEqual([...p('C4 H5 D6 S7 C8')!.key], [5, 2]);
  assert.deepEqual([...p('C10 HJ DQ SK CA')!.key], [11, 2]);

  assert.equal(p('C5 H6 D7 S8 C9')!.cat, 'straight');
  assert.equal(p('C9 H10 DJ SQ CK')!.cat, 'straight');
});

test('顺子不能带 2 和 3', () => {
  assert.equal(p('C3 H4 D5 S6 C7'), null, '34567 必须非法');
  assert.equal(p('CA H2 D3 S4 C5'), null, 'A2345 必须非法');
  assert.equal(p('CJ HQ DK SA C2'), null, 'JQKA2 必须非法');
  assert.equal(p('C2 H3 D4 S5 C6'), null, '23456 必须非法');
});

test('同花：只看花色', () => {
  const flush = p('S4 S6 S7 SJ SK')!;
  assert.equal(flush.cat, 'flush');
  assert.deepEqual([...flush.key], [4]);

  const h = p('HA HK HQ HJ H9')!;
  assert.deepEqual([...h.key], [3]);
});

test('同花顺', () => {
  const sf = p('S10 SJ SQ SK SA')!;
  assert.equal(sf.cat, 'straightFlush');
  assert.deepEqual([...sf.key], [11, 4]);

  const sf2 = p('D5 D6 D7 D8 D9')!;
  assert.deepEqual([...sf2.key], [6, 1]);
});

test('三带二 / 四带一', () => {
  const fh = p('C9 S9 H9 S5 D5')!;
  assert.equal(fh.cat, 'fullHouse');
  assert.equal(CAT_NAMES[fh.cat], '三带二');
  assert.deepEqual([...fh.key], [6, 4, 2, 4]);

  const fp = p('C9 S9 H9 D9 SK')!;
  assert.equal(fp.cat, 'fourPlusOne');
  assert.deepEqual([...fp.key], [6, 4, 10, 4]);
});

test('非法五张牌', () => {
  assert.equal(p('S4 H6 C8 DJ SK'), null);
  assert.equal(p('S9 H9 C9 S5 D7'), null);
});

test('张数超出 1..5 一律非法', () => {
  const seven = classify(parseHand('S3 H3 C3 D4 S5 H6 C7'));
  assert.equal(seven, null);
});
