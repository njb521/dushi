/**
 * 战绩查询单测：游标分页、概览、排名口径。
 * 独立进程 + 临时库（node --test 每个文件一个进程）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import '../src/quiet.ts';

process.env.DUSHI_DATA_DIR = join(tmpdir(), `dushi-stats-${process.pid}-${Date.now()}`);
const db = await import('../src/db.ts');

const mk = (name: string): number => {
  const u = db.createUser(name, 'h');
  assert.ok(u);
  return u.id;
};

test('游标分页：before 只返回更旧的一条，且不重复', () => {
  const uid = mk('pager');
  const m = db.createMatch('100001', '{}', 1);
  for (let i = 1; i <= 5; i++) {
    db.recordRound([
      { matchId: m, roundNo: i, userId: uid, seat: 0, place: 1, isSolo: false, declared: null, delta: i },
    ]);
  }

  const first = db.recentRounds(uid, 2);
  assert.equal(first.length, 2);
  assert.deepEqual(
    first.map((r) => r.round_no),
    [5, 4],
    '最新的在前',
  );

  const older = db.recentRounds(uid, 2, first[1].id);
  assert.deepEqual(
    older.map((r) => r.round_no),
    [3, 2],
    '接着上一页往后翻，不重不漏',
  );
  assert.equal(older[0].id < first[1].id, true);
});

test('概览：胜率、最高单局、按天汇总', () => {
  const uid = mk('sum');
  const m = db.createMatch('100002', '{}', 2);
  db.recordRound([{ matchId: m, roundNo: 1, userId: uid, seat: 0, place: 1, isSolo: false, declared: null, delta: 4 }]);
  db.recordRound([{ matchId: m, roundNo: 2, userId: uid, seat: 0, place: 2, isSolo: false, declared: null, delta: -2 }]);
  db.recordRound([{ matchId: m, roundNo: 3, userId: uid, seat: 0, place: 1, isSolo: true, declared: 'none', delta: 12 }]);

  const s = db.summaryOf(uid);
  assert.equal(s.games, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 66.7);
  assert.equal(s.bestDelta, 12);
  assert.equal(s.soloGames, 1);
  assert.equal(s.soloWins, 1);
  assert.equal(s.totalScore, 14);
  assert.equal(s.last7d.length, 1, '三局都发生在今天，应该合成一天');
  assert.equal(s.last7d[0].delta, 14);
});

test('排名：没打过牌返回 null，打过就按总分/胜场排队', () => {
  const a = mk('rank_a');
  const b = mk('rank_b');
  assert.equal(db.rankOf(a), null, '一局没打不该显示名次');

  // 用大分差，避免受本文件前面几个用例的账号影响
  const m = db.createMatch('100003', '{}', 3);
  db.recordRound([{ matchId: m, roundNo: 1, userId: a, seat: 0, place: 1, isSolo: false, declared: null, delta: 50 }]);
  db.recordRound([{ matchId: m, roundNo: 1, userId: b, seat: 1, place: 2, isSolo: false, declared: null, delta: -50 }]);

  const rows = db.leaderboard(100);
  assert.equal(db.rankOf(a), 1, '分最高就是第 1');
  assert.equal(db.rankOf(b), rows.length, '垫底');
  assert.equal(rows[0].username, 'rank_a');
});

test('排名口径与列表一致：同分比胜场', () => {
  const x = mk('tie_x');
  const y = mk('tie_y');
  const m1 = db.createMatch('100004', '{}', 4);
  // 两人总分都是 2，但 x 拿了两次头游（2 胜），y 是一次 +2（1 胜）
  db.recordRound([
    { matchId: m1, roundNo: 1, userId: x, seat: 0, place: 1, isSolo: false, declared: null, delta: 1 },
    { matchId: m1, roundNo: 1, userId: y, seat: 1, place: 2, isSolo: false, declared: null, delta: -1 },
  ]);
  db.recordRound([
    { matchId: m1, roundNo: 2, userId: x, seat: 0, place: 1, isSolo: false, declared: null, delta: 1 },
    { matchId: m1, roundNo: 2, userId: y, seat: 1, place: 2, isSolo: false, declared: null, delta: -1 },
  ]);
  db.recordRound([
    { matchId: m1, roundNo: 3, userId: x, seat: 0, place: 2, isSolo: false, declared: null, delta: -1 },
    { matchId: m1, roundNo: 3, userId: y, seat: 1, place: 1, isSolo: false, declared: null, delta: 1 },
  ]);
  // 此时 x: 1+1-1=1 分 2 胜；y: -1-1+1=-1 分 1 胜 → x 在前

  const rows = db.leaderboard(20);
  assert.ok(rows.findIndex((r) => r.username === 'tie_x') < rows.findIndex((r) => r.username === 'tie_y'));
  assert.equal(db.rankOf(x), rows.findIndex((r) => r.username === 'tie_x') + 1, 'rankOf 与列表位次一致');
});

test('cleanup', () => {
  db.closeDb();
});
