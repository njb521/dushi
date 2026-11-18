/**
 * 客户端房规 → 安全的 RuleSet。
 *
 * 这是本期唯一的"外部输入入口"，必须当成不可信数据处理：
 * 不 spread、不信任类型、数值一律 clamp。写错了就等于把计分权交给浏览器。
 */

import { DEFAULT_RULES, makeRules } from '@dushi/rules';
import type { RuleSet } from '@dushi/rules';

/** 可以出现在建房面板上的开关（其余键客户端改了也不生效） */
export const EDITABLE_RULE_KEYS = [
  'matchMode',
  'rounds',
  'targetScore',
  'tripsOnlyWhenThreeLeft',
  'mustPlayWhenReporting',
  'baiPaiLeadsFirst',
  'baiPaiMultiplier',
  'allowSurrender',
] as const;

export interface PublicRules {
  matchMode: RuleSet['matchMode'];
  rounds: number;
  targetScore: number;
  tripsOnlyWhenThreeLeft: boolean;
  mustPlayWhenReporting: boolean;
  baiPaiLeadsFirst: boolean;
  baiPaiMultiplier: number;
  allowSurrender: boolean;
}

/**
 * 把任意输入收敛成合法 RuleSet。
 * 未知键丢弃、类型不对回退默认、数值夹到区间内 —— 全程不抛错（老客户端/脏数据不该打断进房）。
 */
export function sanitizeRules(raw: unknown): RuleSet {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const bool = (k: keyof PublicRules, d: boolean): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : d);
  const int = (k: keyof PublicRules, d: number, lo: number, hi: number): number => {
    const v = Number(r[k]);
    if (!Number.isFinite(v)) return d;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };

  const mode: RuleSet['matchMode'] =
    r.matchMode === 'targetScore' || r.matchMode === 'endless' || r.matchMode === 'rounds'
      ? r.matchMode
      : DEFAULT_RULES.matchMode;

  return makeRules({
    matchMode: mode,
    rounds: int('rounds', DEFAULT_RULES.rounds, 1, 99),
    targetScore: int('targetScore', DEFAULT_RULES.targetScore, 10, 500),
    tripsOnlyWhenThreeLeft: bool('tripsOnlyWhenThreeLeft', DEFAULT_RULES.tripsOnlyWhenThreeLeft),
    mustPlayWhenReporting: bool('mustPlayWhenReporting', DEFAULT_RULES.mustPlayWhenReporting),
    baiPaiLeadsFirst: bool('baiPaiLeadsFirst', DEFAULT_RULES.baiPaiLeadsFirst),
    baiPaiMultiplier: int('baiPaiMultiplier', DEFAULT_RULES.baiPaiMultiplier, 1, 3),
    allowSurrender: bool('allowSurrender', DEFAULT_RULES.allowSurrender),
    // 定稿项：不管客户端传什么，都不接受覆盖
    leadMustContainDiamond4: DEFAULT_RULES.leadMustContainDiamond4,
  });
}

/** 给 UI 展示的可编辑子集（等待室回填、房规摘要都用它） */
export function publicRules(rules: RuleSet): PublicRules {
  return {
    matchMode: rules.matchMode,
    rounds: rules.rounds,
    targetScore: rules.targetScore,
    tripsOnlyWhenThreeLeft: rules.tripsOnlyWhenThreeLeft,
    mustPlayWhenReporting: rules.mustPlayWhenReporting,
    baiPaiLeadsFirst: rules.baiPaiLeadsFirst,
    baiPaiMultiplier: rules.baiPaiMultiplier,
    allowSurrender: rules.allowSurrender,
  };
}

/** 一句话房规摘要（房间头部、等待室、结算弹窗共用，前后端同一句话） */
export function rulesSummary(rules: RuleSet): string {
  const mode =
    rules.matchMode === 'rounds'
      ? `${rules.rounds} 局`
      : rules.matchMode === 'targetScore'
        ? `目标 ${rules.targetScore} 分`
        : '无限';

  return [
    `赛制 ${mode}`,
    rules.tripsOnlyWhenThreeLeft ? '三张只在剩 3 张时出' : null,
    rules.mustPlayWhenReporting ? '报单必须压' : '报单可过',
    rules.baiPaiLeadsFirst ? '摆牌先出' : '摆牌不先出',
    `摆牌 ×${rules.baiPaiMultiplier}`,
    rules.allowSurrender ? '可投降' : '不许投降',
  ]
    .filter(Boolean)
    .join(' · ');
}
