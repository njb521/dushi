/**
 * 战绩页：生涯概览 + 最近对局（游标分页）+ 排行榜。
 *
 * 数据全部来自服务端（`/api/stats/summary`、`/api/history`、`/api/leaderboard`），
 * 本地不留缓存 —— 生涯分是"唯一真值在库里"的东西，前端只负责显示。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from './api.ts';
import type { Board, RoundRow, Summary } from './api.ts';
import { PLACE_NAMES } from './view.ts';

const fmtTime = (sec: number): string => {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function Stats({ onClose }: { onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<'me' | 'board'>('me');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<RoundRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadedFirst = useRef(false);

  // 首屏：概览 + 第一页
  useEffect(() => {
    if (loadedFirst.current) return;
    loadedFirst.current = true;
    void (async () => {
      try {
        const [s, h] = await Promise.all([api.summary(), api.history()]);
        setSummary(s);
        setRows(h.rows);
        setCursor(h.nextCursor);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, []);

  // 排行榜按需加载
  useEffect(() => {
    if (tab !== 'board' || board) return;
    void (async () => {
      try {
        setBoard(await api.leaderboard());
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [tab, board]);

  const loadMore = useCallback(async () => {
    if (loading || cursor === null) return;
    setLoading(true);
    try {
      const page = await api.history(cursor);
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

  // 触底加载：哨兵进入视口就翻页
  useEffect(() => {
    const el = sentinel.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  return (
    <div className="modal stats-modal">
      <div className="stats-box">
        <header className="stats-head">
          <h3>战绩</h3>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="tabs">
          <button className={tab === 'me' ? 'on' : ''} onClick={() => setTab('me')}>
            我的战绩
          </button>
          <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
            排行榜
          </button>
        </div>

        {err && <p className="err">{err}</p>}

        {tab === 'me' && (
          <>
            {summary && (
              <div className="stat-grid">
                <div>
                  <b>{summary.totalScore}</b>
                  <span>生涯分</span>
                </div>
                <div>
                  <b>{summary.games}</b>
                  <span>局数</span>
                </div>
                <div>
                  <b>{summary.winRate}%</b>
                  <span>胜率</span>
                </div>
                <div>
                  <b>{summary.bestDelta > 0 ? `+${summary.bestDelta}` : summary.bestDelta}</b>
                  <span>最高单局</span>
                </div>
              </div>
            )}
            {summary && summary.soloGames > 0 && (
              <p className="dim">
                独食 {summary.soloGames} 局 · 头游 {summary.soloWins} 次
              </p>
            )}

            {rows.length === 0 && !loading && summary && (
              <p className="hint">还没打过牌 —— 回大厅开一局吧。</p>
            )}

            <ul className="round-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <span className="t">{fmtTime(r.created_at)}</span>
                  <span className="room">房 {r.room_code}</span>
                  <span className="place">{r.place ? PLACE_NAMES[r.place] : '—'}</span>
                  {r.is_solo === 1 && <em className="tag warn">独食</em>}
                  <span className={`d ${r.delta > 0 ? 'plus' : r.delta < 0 ? 'minus' : 'dim'}`}>
                    {r.delta > 0 ? `+${r.delta}` : r.delta}
                  </span>
                </li>
              ))}
            </ul>
            <div ref={sentinel} className="sentinel">
              {loading ? '加载中…' : cursor === null && rows.length > 0 ? '到底了' : ''}
            </div>
          </>
        )}

        {tab === 'board' && board && (
          <>
            <ol className="board-list">
              {board.rows.map((b, i) => (
                <li key={b.username} className={b.username === board.me.username ? 'me' : ''}>
                  <span className="rank">{i + 1}</span>
                  <span className="name">{b.username}</span>
                  <span className="games dim">{b.games} 局</span>
                  <span className={`d ${b.total_score > 0 ? 'plus' : b.total_score < 0 ? 'minus' : 'dim'}`}>
                    {b.total_score > 0 ? `+${b.total_score}` : b.total_score}
                  </span>
                </li>
              ))}
            </ol>
            {board.me.rank !== null && !board.rows.some((b) => b.username === board.me.username) && (
              <p className="dim">
                我：第 {board.me.rank} 名 · {board.me.totalScore} 分 · {board.me.games} 局
              </p>
            )}
            {board.rows.length === 0 && <p className="hint">还没有人打过牌。</p>}
          </>
        )}
      </div>
    </div>
  );
}
