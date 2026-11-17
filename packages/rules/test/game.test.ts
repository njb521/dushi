import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHand } from '../src/cards.ts';
import { classify } from '../src/pattern.ts';
import { chooseAction } from '../src/ai.ts';
import { createGame, declare, pass, play, settle, validatePlay } from '../src/game.ts';
import { makeFinished, makeState } from './helpers.ts';

const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

function trick(seat: number, code: string) {
  const cards = parseHand(code);
  const pattern = classify(cards);
  if (!pattern) throw new Error(`非法牌面 ${code}`);
  return { seat, pattern, cards };
}

test('2v2 计分：双上 / 一三 / 一四', () => {
  const shuangshang = settle(makeFinished([0, 1, 2, 3], { team: [0, 1] }));
  assert.deepEqual(shuangshang.deltas, [2, 2, -2, -2]);
  assert.equal(shuangshang.reason, '双上');

  const yisan = settle(makeFinished([0, 2, 1, 3], { team: [0, 1] }));
  assert.deepEqual(yisan.deltas, [1, 1, -1, -1]);
  assert.equal(yisan.reason, '一三');

  const yisi = settle(makeFinished([0, 2, 3, 1], { team: [0, 1] }));
  assert.deepEqual(yisi.deltas, [0, 0, 0, 0]);
  assert.equal(yisi.reason, '一四');
});

test('2v2 计分：胜负以头游所在队为准', () => {
  const r = settle(makeFinished([2, 3, 0, 1], { team: [0, 1] }));
  assert.deepEqual(r.deltas, [-2, -2, 2, 2]);
});

test('独食计分：必须头游才赢', () => {
  assert.deepEqual(settle(makeFinished([0, 1, 2, 3], { soloSeat: 0 })).deltas, [6, -2, -2, -2]);
  assert.deepEqual(settle(makeFinished([1, 0, 2, 3], { soloSeat: 0 })).deltas, [-3, 1, 1, 1]);
  assert.deepEqual(settle(makeFinished([1, 2, 0, 3], { soloSeat: 0 })).deltas, [-6, 2, 2, 2]);
  assert.deepEqual(settle(makeFinished([1, 2, 3, 0], { soloSeat: 0 })).deltas, [-9, 3, 3, 3]);
});

test('摆牌：翻倍，且非头游一律判负', () => {
  assert.deepEqual(
    settle(makeFinished([0, 1, 2, 3], { soloSeat: 0, baiPai: true })).deltas,
    [12, -4, -4, -4],
  );
  assert.deepEqual(
    settle(makeFinished([1, 0, 2, 3], { soloSeat: 0, baiPai: true })).deltas,
    [-12, 4, 4, 4],
  );
});

test('投降', () => {
  assert.deepEqual(
    settle(makeFinished([0, 1, 2, 3], { soloSeat: 0, surrendered: true })).deltas,
    [-3, 1, 1, 1],
  );
});

test('所有结算都是零和', () => {
  const allPlaces = [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1],
    [0, 3, 1, 2], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2],
    [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
    [2, 0, 1, 3], [2, 1, 0, 3], [2, 3, 0, 1], [3, 0, 1, 2],
  ];
  const teams: ([number, number] | null)[] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3], null];
  for (const places of allPlaces) {
    for (const team of teams) {
      for (const baiPai of [false, true]) {
        const r = settle(makeFinished(places, { team, soloSeat: team ? null : 0, baiPai }));
        assert.equal(sum(r.deltas), 0, `非零和: places=${places} team=${team} baiPai=${baiPai}`);
      }
    }
  }
});

test('首出必须包含 ♦4', () => {
  const s = makeState(['S3 H4 C5 D6 S7', 'H9 C9 D9 S9', 'C8 H8 D8 S8', 'C10 H10 D10 S10']);
  const v = validatePlay(s, 0, parseHand('S3'));
  assert.equal(v.ok, false);
  assert.match(v.reason!, /♦4/);
});

test('34567 的报错信息要说清原因', () => {
  const s = makeState(['C3 H4 D5 S6 C7 S3', 'H9 C9 D9 S9', 'C8 H8 D8 S8', 'C10 H10 D10 S10']);
  const v = validatePlay(s, 0, parseHand('C3 H4 D5 S6 C7'));
  assert.equal(v.ok, false);
  assert.match(v.reason!, /顺子不能包含 2 或 3/);
});

test('报单不能过', () => {
  const s = makeState(['S3', 'H6', 'C8', 'D9'], { currentSeat: 0 });
  s.trick = trick(1, 'H6');
  assert.throws(() => pass(s, 0), /报单/);
});

test('完整对局可以打完（多个种子）', () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 12345]) {
    const st = createGame(['A', 'B', 'C', 'D'], seed);
    if (st.phase === 'declaring') declare(st, 'none');

    let steps = 0;
    while (st.phase === 'playing' && steps < 1000) {
      const seat = st.currentSeat;
      const action = chooseAction(st, seat);
      if (action.type === 'play') play(st, seat, action.cards);
      else pass(st, seat);
      steps++;
    }
    assert.equal(st.phase, 'settling', `seed ${seed} 没打完`);
    assert.deepEqual([...st.places].sort((a, b) => a - b), [0, 1, 2, 3]);
    const r = settle(st);
    assert.equal(sum(r.deltas), 0);
  }
});
