/**
 * 赛制判定（纯函数）。
 *
 * 为什么单独一个文件：结束条件的口径必须只有一处。M3 之前 `st.round >= ROUNDS`
 * 散在 room.ts 三个地方，前端还各自硬编码了一次 `round < 8` —— 一旦赛制可配置，
 * 这种分散就是"服务端认为结束了、前端还以为能开下一局"的来源。
 *
 * 这里只回答两个问题：**打完了吗**、**现在第几局/多少分**。
 * 判定用累计分（state.scores），不是单局 delta。
 */

import type { RuleSet } from './rules.ts';

export interface MatchProgress {
  mode: 'rounds' | 'targetScore' | 'endless';
  /** 当前第几局（1 起；还没开局为 0） */
  round: number;
  /** 局数制的总局数 */
  rounds: number;
  /** 目标分制的阈值 */
  target: number;
  /** 各座位累计分（整场，不是单局） */
  totals: number[];
  /** 本场是否已结束 */
  over: boolean;
  /** 顶部展示文案："第 3/8 局" / "32/50 分" / "打到喊停" */
  label: string;
}

/**
 * 本场是否结束。
 * - 局数制：打完 N 局
 * - 目标分制：任意一家累计分的**绝对值**达到阈值（打到 −50 也算输光结束）
 * - 无限制：永不自动结束，靠房主喊停（room 层处理）
 */
export function matchOver(round: number, scores: readonly number[], rules: RuleSet): boolean {
  if (rules.matchMode === 'rounds') return round >= rules.rounds;
  if (rules.matchMode === 'targetScore') return scores.some((s) => Math.abs(s) >= rules.targetScore);
  return false;
}

/** 目标分制下"离结束还有多远"看的是绝对值最大的那家 */
function closestToTarget(scores: readonly number[]): number {
  return scores.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
}

export function matchProgress(
  round: number,
  scores: readonly number[],
  rules: RuleSet,
  forcedOver = false,
): MatchProgress {
  const totals = scores.length === 4 ? [...scores] : [0, 0, 0, 0];
  const over = forcedOver || matchOver(round, totals, rules);

  let label: string;
  if (rules.matchMode === 'rounds') {
    label = `第 ${Math.max(round, 1)}/${rules.rounds} 局`;
  } else if (rules.matchMode === 'targetScore') {
    label = `${closestToTarget(totals)}/${rules.targetScore} 分`;
  } else {
    label = '打到喊停';
  }

  return {
    mode: rules.matchMode,
    round,
    rounds: rules.rounds,
    target: rules.targetScore,
    totals,
    over,
    label,
  };
}
