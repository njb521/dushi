/**
 * 视图层的信息隔离（设计文档 §5.2）。
 *
 * 这里盯的是一个很具体的泄露：独食宣告阶段只有被问的那个人能看到 `declaring`。
 * 其余三人一旦看到这个阶段，就等于知道"本局存在暗独食" —— 而手里一张身份牌
 * 都没拿到的人，本来推不出这件事（他既不知道 ♠3、♠A 分在两家还是同在一家）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, declare } from '@dushi/rules';
import { GameRuntime } from '../src/room.ts';
import { buildView, publicPhase } from '../src/views.ts';

/** 造一个真的会进宣告阶段的房间 */
function roomWithSolo(): { g: GameRuntime; solo: number } {
  for (let seed = 1; seed < 2000; seed++) {
    const st = createGame(['A', 'B', 'C', 'D'], seed);
    if (st.phase !== 'declaring') continue;
    const g = new GameRuntime('123456');
    g.phase = 'ingame';
    g.state = st;
    return { g, solo: st.soloSeat! };
  }
  throw new Error('2000 个种子里没有独食局');
}

test('宣告阶段：只有独食者看到 declaring，其余三家看到 playing', () => {
  const { g, solo } = roomWithSolo();

  const mine = buildView(g, solo);
  assert.equal(mine.phase, 'declaring', '被问的人该看到宣告弹窗');
  assert.equal(mine.declareAsk, true);

  for (let s = 0; s < 4; s++) {
    if (s === solo) continue;
    const v = buildView(g, s);
    assert.equal(v.phase, 'playing', `座位 ${s} 不该看到宣告阶段`);
    assert.equal(v.declareAsk, false);
    assert.equal(v.turn, null, '也不是他的回合');
  }
});

test('宣告阶段：三种席位都看不到独食者是谁', () => {
  const { g, solo } = roomWithSolo();
  for (let s = 0; s < 4; s++) {
    const v = buildView(g, s);
    assert.equal(v.settle, null, '还没结算，不能给 soloSeat');
    assert.equal(v.baiPaiHand, null, '没摆牌就不能公开手牌');
    assert.equal(v.seats[solo].revealed, false, '没打身份牌就不该亮');
  }
});

test('不表态之后：所有人的公共日志里都没有独食者的名字', () => {
  const { g, solo } = roomWithSolo();
  const name = g.state!.seats[solo].name;

  declare(g.state!, 'none');

  for (let s = 0; s < 4; s++) {
    const v = buildView(g, s);
    assert.equal(v.phase, 'playing');
    assert.ok(
      !v.eventLog.some((l) => l.includes(name)),
      `座位 ${s} 的日志里出现了独食者名字：${v.eventLog.join(' | ')}`,
    );
    assert.ok(!v.eventLog.some((l) => l.includes('表态')), '不该留下"表态"痕迹');
  }
});

test('不表态之后：座位上手牌张数一致，没有额外泄露字段', () => {
  const { g } = roomWithSolo();
  declare(g.state!, 'none');
  const v = buildView(g, 0);
  assert.equal(v.seats.length, 4);
  for (const s of v.seats) assert.equal(s.cards, 13, '开局每人 13 张');
});

test('publicPhase：没有牌局就是等待中', () => {
  assert.equal(publicPhase(null, 0), 'waiting');
});
