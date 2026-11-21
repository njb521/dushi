/**
 * 新手引导：首次进牌桌弹一次，三页。
 *
 * 只讲三件"不看就会一直打错"的事：牌序反直觉、3/2 进不了顺子、身份牌不能单独留到最后。
 * 篇幅刻意压到最小 —— 看说明书的没人记得住，真正的兜底是牌桌上的即时提示
 * （出不了牌时那行红字、身份牌的红框），这里只是给个全景。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

const SEEN_KEY = 'dushi.intro.v1';

export function introSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // 存不了就当看过，别每次都弹
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

/** 小牌面，只给引导卡用（不复用牌桌组件，避免样式互相牵扯） */
function Mini({ r, red }: { r: string; red?: boolean }): ReactElement {
  return <span className={`mini${red ? ' red' : ''}`}>{r}</span>;
}

const PAGES = [
  {
    title: '牌序是反的',
    body: (
      <>
        <div className="intro-row">
          <Mini r="3" />
          <Mini r="2" />
          <Mini r="A" red />
          <Mini r="K" red />
          <Mini r="Q" red />
          <Mini r="J" red />
          <Mini r="10" />
          <Mini r="9" />
          <Mini r="8" />
          <Mini r="7" />
          <Mini r="6" />
          <Mini r="5" />
          <Mini r="4" />
        </div>
        <p className="intro-note">大 ←—— 从左到右 ——→ 小</p>
        <p>
          <b>3 最大，4 最小。</b>♠3 是全场最大的单张，♦4 是全场最小的牌（也是先出的那张）。
        </p>
        <p className="dim">花色：♠ &gt; ♥ &gt; ♣ &gt; ♦</p>
      </>
    ),
  },
  {
    title: '3 和 2 不能进顺子',
    body: (
      <>
        <div className="intro-row bad">
          <Mini r="3" />
          <Mini r="4" />
          <Mini r="5" />
          <Mini r="6" />
          <Mini r="7" />
          <span className="intro-x">✕</span>
        </div>
        <div className="intro-row good">
          <Mini r="4" />
          <Mini r="5" />
          <Mini r="6" />
          <Mini r="7" />
          <Mini r="8" />
          <span className="intro-x">✓</span>
        </div>
        <p>
          顺子只有 <b>4-8 到 10-A</b> 这 7 种，A 只能当最大。五张牌的大小：
        </p>
        <p className="dim">顺子 &lt; 同花 &lt; 三带二 &lt; 四带一 &lt; 同花顺</p>
        <p className="dim">同花只比花色，同花色谁也压不动谁。</p>
      </>
    ),
  },
  {
    title: '身份牌别单独留到最后',
    body: (
      <>
        <div className="intro-row">
          <Mini r="♠3" />
          <Mini r="♠A" />
        </div>
        <p>
          这两张是<b>队友凭据</b>：分在两家 = 2 打 2；同在一家 = 他一个人打三家（独食）。
          谁打出它们，谁的身份就亮出来。
        </p>
        <p>
          但<b>最后一张单出的牌如果是它</b>，直接判最后一名 —— 独食者也不例外。
          想甩掉就把它塞进同花 / 三带二里一起出，那样不算。
        </p>
      </>
    ),
  },
];

export function Intro({ onDone }: { onDone: () => void }): ReactElement {
  const [page, setPage] = useState(0);
  const last = page === PAGES.length - 1;
  const done = (): void => {
    markIntroSeen();
    onDone();
  };

  return (
    <div className="modal intro-modal">
      <div className="modal-box intro-box">
        <div className="intro-dots">
          {PAGES.map((_, i) => (
            <i key={i} className={i === page ? 'on' : ''} />
          ))}
        </div>
        <h3>{PAGES[page].title}</h3>
        <div className="intro-body">{PAGES[page].body}</div>
        <div className="intro-actions">
          <button className="ghost" onClick={done}>
            跳过
          </button>
          {last ? (
            <button className="primary" onClick={done}>
              开始打牌
            </button>
          ) : (
            <button className="primary" onClick={() => setPage((p) => p + 1)}>
              下一页
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
