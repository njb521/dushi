/**
 * 规则速查（一屏能看完的版本）。
 *
 * 大厅和牌桌共用同一份文案 —— 之前牌桌里看不到规则，打到一半想确认"3 能不能进顺子"
 * 得先退出房间。文案只留一份，避免两处各改各的。
 */

import type { ReactElement } from 'react';

export const RULES_TEXT = `牌大→小: 3 2 A K Q J 10 9 8 7 6 5 4
花色: ♠>♥>♣>♦   ♠3 最大 ♦4 最小
♦4 持有者先出，首手必须带 ♦4
顺子只有 4-8 到 10-A（2、3 不入顺）
同花只比花色（♠>♥>♣>♦，同花色压不动）
五张跨型: 顺<同花<三带二<四带一<同花顺
报单（剩1张）能压必须压
身份牌（♠3/♠A）单独留到最后一张出 → 判最后一名
♠3+♠A 同持=独食(1v3)；头游+12 二游-6 三四游-12`;

export function RulesCard(): ReactElement {
  return <pre className="rules-card">{RULES_TEXT}</pre>;
}
