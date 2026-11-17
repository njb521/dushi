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
  assert.deepEqual(shuangshang.deltas, [4, 4, -4, -4]);
  assert.equal(shuangshang.reason, '双上');

  const yisan = settle(makeFinished([0, 2, 1, 3], { team: [0, 1] }));
  assert.deepEqual(yisan.deltas, [2, 2, -2, -2]);
  assert.equal(yisan.reason, '一三');

  const yisi = settle(makeFinished([0, 2, 3, 1], { team: [0, 1] }));
  assert.deepEqual(yisi.deltas, [0, 0, 0, 0]);
  assert.equal(yisi.reason, '一四');
});

test('2v2 计分：胜负以头游所在队为准', () => {
  const r = settle(makeFinished([2, 3, 0, 1], { team: [0, 1] }));
  assert.deepEqual(r.deltas, [-4, -4, 4, 4]);
});

test('独食计分：头游 +12，二游 −6，三四游 −12（三家均摊）', () => {
  assert.deepEqual(settle(makeFinished([0, 1, 2, 3], { soloSeat: 0 })).deltas, [12, -4, -4, -4]);
  assert.deepEqual(settle(makeFinished([1, 0, 2, 3], { soloSeat: 0 })).deltas, [-6, 2, 2, 2]);
  assert.deepEqual(settle(makeFinished([1, 2, 0, 3], { soloSeat: 0 })).deltas, [-12, 4, 4, 4]);
  assert.deepEqual(settle(makeFinished([1, 2, 3, 0], { soloSeat: 0 })).deltas, [-12, 4, 4, 4]);
});

test('摆牌：按名次翻倍（头游 +24，二游 −12，三四游 −24）', () => {
  assert.deepEqual(
    settle(makeFinished([0, 1, 2, 3], { soloSeat: 0, baiPai: true })).deltas,
    [24, -8, -8, -8],
  );
  assert.deepEqual(
    settle(makeFinished([1, 0, 2, 3], { soloSeat: 0, baiPai: true })).deltas,
    [-12, 4, 4, 4],
    '二游本身就是负分，翻倍后仍是输',
  );
  assert.deepEqual(
    settle(makeFinished([1, 2, 3, 0], { soloSeat: 0, baiPai: true })).deltas,
    [-24, 8, 8, 8],
  );
});

test('投降：按四游算（−12，三家各 +4）', () => {
  assert.deepEqual(
    settle(makeFinished([0, 1, 2, 3], { soloSeat: 0, surrendered: true })).deltas,
    [-12, 4, 4, 4],
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

// ── 身份牌留到最后（v0.3 新规 §2.15）─────────────────────
// 出完手牌的那一手带 ♠3 / ♠A → 直接判最后一名，不论独食者还是队伍成员。

test('身份牌留到最后：独食者拿 ♠3 收尾 → 判四游，−12', () => {
  const st = makeState(['S3', 'HK', 'HQ', 'HJ'], {
    soloSeat: 0,
    requireD4: false,
    firstPlayDone: true,
  });
  play(st, 0, parseHand('S3'));
  assert.equal(st.phase, 'settling');
  assert.deepEqual(st.places, [1, 2, 3, 0], '把出完的独食者挪到末位');
  const r = settle(st);
  assert.equal(r.reason, '独食四游');
  assert.deepEqual(r.deltas, [-12, 4, 4, 4]);
});

test('身份牌留到最后：队伍里的人一样判最后，连带把队伍成绩打成“一四”', () => {
  const st = makeState(['S3', 'HK', 'HQ', 'HJ'], {
    team: [0, 1],
    requireD4: false,
    firstPlayDone: true,
  });
  play(st, 0, parseHand('S3')); // 座位 0 用 ♠3 收尾，本以为是头游
  assert.equal(st.phase, 'playing', '队伍还没出完，牌局继续');
  pass(st, 1); // ♥K 压不过 ♠3
  pass(st, 2);
  pass(st, 3);
  play(st, 1, parseHand('HK')); // 座位 1 出完，队伍两人都出完
  assert.equal(st.phase, 'settling');
  assert.deepEqual(st.places, [1, 2, 3, 0]);
  const r = settle(st);
  assert.equal(r.reason, '一四');
  assert.deepEqual(r.deltas, [0, 0, 0, 0]);
});

test('身份牌留到最后：出完那一手是多张带 ♠3 也算', () => {
  const st = makeState(['S3 S5 S7 S9 SJ', 'HK', 'HQ', 'HJ'], {
    soloSeat: 0,
    requireD4: false,
    firstPlayDone: true,
  });
  const combo = parseHand('S3 S5 S7 S9 SJ');
  assert.equal(validatePlay(st, 0, combo).ok, true, '♠3 可以进同花');
  play(st, 0, combo);
  assert.deepEqual(st.places, [1, 2, 3, 0]);
});

test('最后一张不是身份牌：名次照常', () => {
  const st = makeState(['HK', 'HQ', 'HJ', 'H10'], {
    soloSeat: 0,
    requireD4: false,
    firstPlayDone: true,
  });
  play(st, 0, parseHand('HK'));
  assert.deepEqual(st.places, [0, 1, 2, 3]);
  assert.deepEqual(settle(st).deltas, [12, -4, -4, -4]);
});
