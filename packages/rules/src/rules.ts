/**
 * 规则开关。定稿项（顺子范围、独食计分表、同花只看花色）不可配置，
 * 其余按设计文档 §2.14 开放给房主。
 */

export type MatchMode = 'rounds' | 'targetScore' | 'endless';

export interface RuleSet {
  /** 三张只能在剩 3 张时打出（"寻鸡笼"变体） */
  readonly tripsOnlyWhenThreeLeft: boolean;
  /** 首出必须包含 ♦4 */
  readonly leadMustContainDiamond4: boolean;
  /** 摆牌时由独食者首出且免 ♦4 限制 */
  readonly baiPaiLeadsFirst: boolean;
  /** 摆牌倍数 */
  readonly baiPaiMultiplier: number;
  /** 报单（剩 1 张）能压住就必须压 */
  readonly mustPlayWhenReporting: boolean;
  /** 允许投降 */
  readonly allowSurrender: boolean;
  /** 独食宣告倒计时（毫秒） */
  readonly declareWindowMs: number;
  /** 出牌倒计时（毫秒） */
  readonly turnTimeoutMs: number;
  /** 赛制 */
  readonly matchMode: MatchMode;
  /** 局数赛制：共几局 */
  readonly rounds: number;
  /** 目标分赛制：达到多少分结束 */
  readonly targetScore: number;
}

export const DEFAULT_RULES: RuleSet = {
  tripsOnlyWhenThreeLeft: false,
  leadMustContainDiamond4: true,
  baiPaiLeadsFirst: true,
  baiPaiMultiplier: 2,
  mustPlayWhenReporting: true,
  allowSurrender: true,
  declareWindowMs: 10_000,
  turnTimeoutMs: 30_000,
  matchMode: 'rounds',
  rounds: 8,
  targetScore: 50,
};

export function makeRules(patch: Partial<RuleSet> = {}): RuleSet {
  return { ...DEFAULT_RULES, ...patch };
}
