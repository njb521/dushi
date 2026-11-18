import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRules } from '../src/rules.ts';
import { matchOver, matchProgress } from '../src/match.ts';

const S = [12, -4, -4, -4];

test('局数制：第 8 局结束，第 7 局不结束', () => {
  const rules = makeRules({ matchMode: 'rounds', rounds: 8 });
  assert.equal(matchOver(7, [0, 0, 0, 0], rules), false);
  assert.equal(matchOver(8, [0, 0, 0, 0], rules), true);
  assert.equal(matchOver(9, [0, 0, 0, 0], rules), true, '超了也算结束，不能因为越界就继续开');
});

test('目标分制：任意一家绝对值到线即结束（正负两侧都算）', () => {
  const rules = makeRules({ matchMode: 'targetScore', targetScore: 20 });
  assert.equal(matchOver(3, S, rules), false, '最大 12，还没到 20');
  assert.equal(matchOver(4, [20, -7, -7, -6], rules), true, '正侧到线');
  assert.equal(matchOver(4, [-20, 7, 7, 6], rules), true, '负侧到线（输光也是结束）');
  assert.equal(matchOver(4, [19, -7, -7, -5], rules), false);
});

test('无限赛制：永远不自动结束', () => {
  const rules = makeRules({ matchMode: 'endless' });
  assert.equal(matchOver(1, [0, 0, 0, 0], rules), false);
  assert.equal(matchOver(999, [500, -200, -200, -100], rules), false);
});

test('进度文案：三种赛制各一句', () => {
  assert.equal(matchProgress(3, S, makeRules({ matchMode: 'rounds', rounds: 8 })).label, '第 3/8 局');
  assert.equal(matchProgress(3, S, makeRules({ matchMode: 'targetScore', targetScore: 20 })).label, '12/20 分');
  assert.equal(matchProgress(3, S, makeRules({ matchMode: 'endless' })).label, '打到喊停');
});

test('房主喊停：forcedOver 直接算结束，与赛制无关', () => {
  const rules = makeRules({ matchMode: 'endless' });
  assert.equal(matchProgress(3, S, rules).over, false);
  assert.equal(matchProgress(3, S, rules, true).over, true);
});

test('进度只读：返回的 totals 是副本，改它不影响原数组', () => {
  const scores = [...S];
  const p = matchProgress(1, scores, makeRules());
  p.totals[0] = 999;
  assert.equal(scores[0], 12);
});
