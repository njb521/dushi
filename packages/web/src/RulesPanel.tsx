/**
 * 房规面板（建房时设置 + 等待室房主修改，两处复用）。
 *
 * 只负责"编辑一个 RuleDraft"，不关心值从哪来：大厅里是本地 state，
 * 房间里是服务端下发的 view.rules（改动即 send('setRules')，服务端校验后回推）。
 */

import type { ReactElement } from 'react';
import type { RuleDraft } from './view.ts';

export const DEFAULT_RULES: RuleDraft = {
  matchMode: 'rounds',
  rounds: 8,
  targetScore: 50,
  tripsOnlyWhenThreeLeft: false,
  mustPlayWhenReporting: true,
  baiPaiLeadsFirst: true,
  baiPaiMultiplier: 2,
  allowSurrender: true,
};

/** 一句话概括，折叠标题上用 */
export function draftSummary(r: RuleDraft): string {
  const mode = r.matchMode === 'rounds' ? `${r.rounds} 局` : r.matchMode === 'targetScore' ? `目标 ${r.targetScore} 分` : '无限';
  return `${mode} · 摆牌 ×${r.baiPaiMultiplier}${r.mustPlayWhenReporting ? ' · 报单必压' : ''}`;
}

export function RulesPanel({
  value,
  onChange,
  disabled,
}: {
  value: RuleDraft;
  onChange: (next: RuleDraft) => void;
  disabled?: boolean;
}): ReactElement {
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]): void => {
    if (disabled) return;
    onChange({ ...value, [k]: v });
  };

  return (
    <div className={`rules-panel${disabled ? ' locked' : ''}`}>
      <div className="seg">
        {(
          [
            ['rounds', '局数'],
            ['targetScore', '目标分'],
            ['endless', '无限'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={value.matchMode === k ? 'on' : ''}
            disabled={disabled}
            onClick={() => set('matchMode', k)}
          >
            {label}
          </button>
        ))}
      </div>

      {value.matchMode === 'rounds' && (
        <label className="num-row">
          <span>打几局</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={value.rounds}
            disabled={disabled}
            onChange={(e) => set('rounds', Number(e.target.value) || 1)}
          />
        </label>
      )}
      {value.matchMode === 'targetScore' && (
        <label className="num-row">
          <span>目标分（±N，谁先到谁结束）</span>
          <input
            type="number"
            inputMode="numeric"
            min={10}
            max={500}
            value={value.targetScore}
            disabled={disabled}
            onChange={(e) => set('targetScore', Number(e.target.value) || 10)}
          />
        </label>
      )}
      {value.matchMode === 'endless' && <p className="hint">无限赛制：打到你点「结束本场」为止。</p>}

      <label className="opt-row">
        <input
          type="checkbox"
          checked={value.tripsOnlyWhenThreeLeft}
          disabled={disabled}
          onChange={(e) => set('tripsOnlyWhenThreeLeft', e.target.checked)}
        />
        <span>三张只能在自己剩 3 张时出（寻鸡笼变体）</span>
      </label>
      <label className="opt-row">
        <input
          type="checkbox"
          checked={value.mustPlayWhenReporting}
          disabled={disabled}
          onChange={(e) => set('mustPlayWhenReporting', e.target.checked)}
        />
        <span>报单（剩 1 张）能压必须压</span>
      </label>
      <label className="opt-row">
        <input
          type="checkbox"
          checked={value.baiPaiLeadsFirst}
          disabled={disabled}
          onChange={(e) => set('baiPaiLeadsFirst', e.target.checked)}
        />
        <span>摆牌后由独食者先出（免 ♦4）</span>
      </label>
      <label className="opt-row">
        <input
          type="checkbox"
          checked={value.allowSurrender}
          disabled={disabled}
          onChange={(e) => set('allowSurrender', e.target.checked)}
        />
        <span>允许独食者投降</span>
      </label>

      <label className="num-row">
        <span>摆牌倍数</span>
        <div className="seg small">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              className={value.baiPaiMultiplier === n ? 'on' : ''}
              disabled={disabled}
              onClick={() => set('baiPaiMultiplier', n)}
            >
              ×{n}
            </button>
          ))}
        </div>
      </label>
    </div>
  );
}
