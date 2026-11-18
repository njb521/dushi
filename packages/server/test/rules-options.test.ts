/**
 * 房规校验层单测：客户端传什么都得收敛成合法 RuleSet。
 * 这层是防"浏览器改赛制刷分"的唯一闸门，所以越界的、伪造的、缺字段的都要覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES } from '@dushi/rules';
import { publicRules, rulesSummary, sanitizeRules } from '../src/rules-options.ts';

test('空/脏输入：一律回退默认值，不抛错', () => {
  for (const raw of [undefined, null, 0, 'x', [], {}, { matchMode: 123 }]) {
    const r = sanitizeRules(raw);
    assert.equal(r.matchMode, DEFAULT_RULES.matchMode, `输入 ${JSON.stringify(raw)}`);
    assert.equal(r.rounds, DEFAULT_RULES.rounds);
    assert.equal(r.targetScore, DEFAULT_RULES.targetScore);
  }
});

test('数值越界：夹到区间内而不是报错', () => {
  assert.equal(sanitizeRules({ rounds: 0 }).rounds, 1);
  assert.equal(sanitizeRules({ rounds: 999 }).rounds, 99);
  assert.equal(sanitizeRules({ rounds: 3.6 }).rounds, 4, '取整');
  assert.equal(sanitizeRules({ rounds: 'abc' }).rounds, DEFAULT_RULES.rounds, '非数字回默认');
  assert.equal(sanitizeRules({ targetScore: 5 }).targetScore, 10);
  assert.equal(sanitizeRules({ targetScore: 9999 }).targetScore, 500);
});

test('刷分向：摆牌倍数被夹到 1–3，传 1e9 也只能到 3', () => {
  assert.equal(sanitizeRules({ baiPaiMultiplier: 1e9 }).baiPaiMultiplier, 3);
  assert.equal(sanitizeRules({ baiPaiMultiplier: 0 }).baiPaiMultiplier, 1);
  assert.equal(sanitizeRules({ baiPaiMultiplier: -5 }).baiPaiMultiplier, 1);
  assert.equal(sanitizeRules({ baiPaiMultiplier: 2.4 }).baiPaiMultiplier, 2);
});

test('定稿项不可被客户端改写', () => {
  const r = sanitizeRules({ leadMustContainDiamond4: false, declareWindowMs: 1, turnTimeoutMs: 1 });
  assert.equal(r.leadMustContainDiamond4, true, '首出必须带 ♦4 是定稿项');
  assert.equal(r.declareWindowMs, DEFAULT_RULES.declareWindowMs);
  assert.equal(r.turnTimeoutMs, DEFAULT_RULES.turnTimeoutMs);
});

test('未知键丢弃，不会混进 RuleSet', () => {
  const r = sanitizeRules({ hack: 'yes', __proto__: { polluted: true } }) as Record<string, unknown>;
  assert.equal('hack' in r, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, '不能污染原型');
});

test('合法开关原样保留', () => {
  const r = sanitizeRules({
    matchMode: 'targetScore',
    targetScore: 30,
    tripsOnlyWhenThreeLeft: true,
    mustPlayWhenReporting: false,
    baiPaiLeadsFirst: false,
    allowSurrender: false,
  });
  assert.equal(r.matchMode, 'targetScore');
  assert.equal(r.targetScore, 30);
  assert.equal(r.tripsOnlyWhenThreeLeft, true);
  assert.equal(r.mustPlayWhenReporting, false);
  assert.equal(r.baiPaiLeadsFirst, false);
  assert.equal(r.allowSurrender, false);
});

test('publicRules 只回可编辑子集，且能原样喂回 sanitize', () => {
  const pub = publicRules(sanitizeRules({ rounds: 3, baiPaiMultiplier: 2 }));
  assert.deepEqual(Object.keys(pub).sort(), [
    'allowSurrender',
    'baiPaiLeadsFirst',
    'baiPaiMultiplier',
    'matchMode',
    'mustPlayWhenReporting',
    'rounds',
    'targetScore',
    'tripsOnlyWhenThreeLeft',
  ]);
  assert.equal(sanitizeRules(pub).rounds, 3, '往返一圈不丢设置');
});

test('房规摘要：三种赛制都说人话', () => {
  assert.match(rulesSummary(sanitizeRules({ matchMode: 'rounds', rounds: 8 })), /赛制 8 局/);
  assert.match(rulesSummary(sanitizeRules({ matchMode: 'targetScore', targetScore: 30 })), /目标 30 分/);
  assert.match(rulesSummary(sanitizeRules({ matchMode: 'endless' })), /无限/);
  assert.match(rulesSummary(sanitizeRules({ mustPlayWhenReporting: false })), /报单可过/);
  assert.match(rulesSummary(sanitizeRules({ baiPaiMultiplier: 3 })), /摆牌 ×3/);
});
