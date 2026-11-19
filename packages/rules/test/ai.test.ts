import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHand } from '../src/cards.ts';
import type { Card } from '../src/cards.ts';
import { classify } from '../src/pattern.ts';
import { chooseAction, matesOf } from '../src/ai.ts';
import { makeState } from './helpers.ts';

const label = (c: Card): string => `${c.r}${c.s}`;

/** 造一个"某座位刚打出这几张牌"的圈 */
function tr(seat: number, code: string) {
  const cards = parseHand(code);
  const pattern = classify(cards);
  if (!pattern) throw new Error(`非法牌面 ${code}`);
  return { seat, pattern, cards };
}

const base = { firstPlayDone: true, requireD4: false } as const;

test('不压队友：队友赢着这一圈就让过', () => {
  const st = makeState(['H9', 'S3 H5 H6', 'C7 C8', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
    trick: tr(0, 'H9'),
  });
  assert.equal(chooseAction(st, 1).type, 'pass', '座位 0 是我队友，不该压');
});

test('队友报单：首出最小的单张，把牌权递过去', () => {
  const st = makeState(['H9', 'H4 HK HQ', 'C7 C8', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
  });
  const a = chooseAction(st, 1);
  assert.equal(a.type, 'play');
  assert.deepEqual((a as { cards: Card[] }).cards.map(label), ['4H']);
});

test('对手报单：首出最大的单张堵门', () => {
  const st = makeState(['H9 H10', 'H4 HK HQ', 'C7', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
  });
  const a = chooseAction(st, 1);
  assert.equal(a.type, 'play');
  assert.deepEqual((a as { cards: Card[] }).cards.map(label), ['KH'], '宁可亮身份也不能放走报单的对手');
});

test('手牌还多时不拆对子去压小单张：不划算就让过', () => {
  const st = makeState(['H10 H10', 'S9 C9 H9 D9 SK CK SQ CQ', 'H5 H6', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
    trick: tr(2, 'H5'),
  });
  assert.equal(chooseAction(st, 1).type, 'pass', '手里还有 8 张、对面只出了张小 5，留着对子');
});

test('残局（≤7 张）就不再死守组合：拆也要压', () => {
  const st = makeState(['H10 H10', 'S9 C9 H9 D9 SK CK', 'H5 H6', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
    trick: tr(2, 'H5'),
  });
  const a = chooseAction(st, 1);
  assert.equal(a.type, 'play', '只剩 6 张，牌权比结构值钱');
  assert.equal((a as { cards: Card[] }).cards.length, 1);
  assert.equal((a as { cards: Card[] }).cards[0].r, '9', '拆一张 9 去压（四张 9 里最小的那张）');
});

test('对面已经压到 K，宁可拆对子也要抢回来', () => {
  const st = makeState(['H10 H10', 'S9 C9 H9 D9 SK CK SQ CQ', 'HK', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
    trick: tr(2, 'HK'),
  });
  const a = chooseAction(st, 1);
  assert.equal(a.type, 'play', 'K 这手放过去基本等于白送一圈');
});

test('但对手报单时，该拆也得拆', () => {
  const st = makeState(['H10 H10', 'S9 C9 C4', 'H5 H6', 'D7'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
    trick: tr(2, 'H5'),
  });
  const a = chooseAction(st, 1);
  assert.equal(a.type, 'play', '座位 3 只剩 1 张，必须压');
  assert.deepEqual((a as { cards: Card[] }).cards.map((c) => c.r), ['9'], '拆对子也要压');
});

test('有干净牌就压：用最小的那手', () => {
  const st = makeState(['H10 H10', 'S9 C8 C4', 'H5 H6', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
    trick: tr(2, 'H5'),
  });
  const a = chooseAction(st, 1);
  assert.deepEqual((a as { cards: Card[] }).cards.map(label), ['8C'], 'C8 能压且不拆组合');
});

test('能一把出完就出完', () => {
  const st = makeState(['H10 H10', 'S9 C9', 'H5 H6', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
  });
  const a = chooseAction(st, 1);
  assert.deepEqual((a as { cards: Card[] }).cards.map(label).sort(), ['9C', '9S']);
});

test('身份牌不拿来收尾：优先把它打出去', () => {
  const st = makeState(['H10 H10', 'S3 H4', 'H5 H6', 'D7 D8'], {
    ...base,
    team: [0, 1],
    currentSeat: 1,
  });
  const a = chooseAction(st, 1);
  assert.deepEqual((a as { cards: Card[] }).cards.map(label), ['3S'], '先出 ♠3，别让它落到最后一张');
});

test('独食者没有队友：对面报单一样要压', () => {
  const st = makeState(['H10 H10', 'S9 C9 C4', 'H5', 'D7 D8'], {
    ...base,
    soloSeat: 1,
    currentSeat: 1,
    trick: tr(2, 'H5'),
  });
  // 独食局 state.team 为 null，matesOf 返回空 → 所有人都是对手
  assert.equal(st.team, null);
  const a = chooseAction(st, 1);
  assert.equal(a.type, 'play', '座位 2 只剩 1 张，独食者必须压');
});

test('matesOf：独食局里三家互为同盟，独食者孤身', () => {
  const solo = makeState(['H9 H10', 'H5 H6', 'C7 C8', 'D7 D8'], { ...base, soloSeat: 0 });
  assert.deepEqual(matesOf(solo, 0), [], '独食者没有队友');
  assert.deepEqual(matesOf(solo, 1), [2, 3], '另外三家互相是队友');
  assert.deepEqual(matesOf(solo, 3), [1, 2]);

  const team = makeState(['H9 H10', 'H5 H6', 'C7 C8', 'D7 D8'], { ...base, team: [0, 1] });
  assert.deepEqual(matesOf(team, 0), [1]);
  assert.deepEqual(matesOf(team, 2), [3]);
});

test('独食局：三家不互相压（以前会）', () => {
  const st = makeState(['H9 H10', 'H5', 'S3 HK HQ', 'D7 D8'], {
    ...base,
    soloSeat: 0,
    currentSeat: 2,
    trick: tr(1, 'H5'),
  });
  assert.equal(chooseAction(st, 2).type, 'pass', '座位 1 也是一家防守方，不该压他');
});
