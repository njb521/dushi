import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { classify, legalPlays, sortByPower } from '@dushi/rules';
import type { Card } from '@dushi/rules';
import { SUIT_CHAR, isRed, cardCode, PLACE_NAMES } from './view.ts';
import type { View, SeatView, RuleDraft } from './view.ts';
import { Auth } from './Auth.tsx';
import { DEFAULT_RULES, RulesPanel, draftSummary } from './RulesPanel.tsx';
import { Stats } from './Stats.tsx';
import { api } from './api.ts';
import type { Me } from './api.ts';

// ── 连接 ────────────────────────────────────────────────

function endpoint(): string {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const host = location.port === '5173' ? `${location.hostname}:3000` : location.host;
  return `${proto}${host}`;
}

const stored = <T,>(k: string, def: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
};

/** 重连凭证放 sessionStorage：同一标签页刷新能回来，关掉标签页则失效（够用且不留痕） */
const TOKEN_KEY = 'dushi.rtok';
/** 页面离开时打的戳 —— 座位只保留 60 秒，隔太久再回来就不必去试了 */
const LEFT_AT_KEY = 'dushi.leftat';
/**
 * 预留席位的保留时长是 60 秒（服务端 `allowReconnection(client, 60)`），
 * 而且是**从连接断掉那一刻**开始算，不是从发 token 的时候算。
 * 所以这里不能用"token 多老"来判断，只能用"我上次离开页面是什么时候"。
 * 留 5 秒余量，避免卡在边界上白试一次。
 */
const RECONNECT_WINDOW_MS = 55_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Colyseus 的错误码：这几种是"座位确定没了"，重试只会让服务端多刷几行 ❌ */
const GONE_CODES = new Set([4212 /* room disposed */, 4213 /* unhandled */, 4214 /* expired */]);
const isGone = (e: unknown): boolean => GONE_CODES.has((e as { code?: number })?.code ?? 0);

export function App(): ReactElement {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <div className="lobby">
        <div className="lobby-box">
          <p className="dim">载入中…</p>
        </div>
      </div>
    );
  }
  if (me === null) return <Auth onDone={setMe} />;
  return <Lobby me={me} onMe={setMe} />;
}

// ── 大厅 ────────────────────────────────────────────────

function Lobby({ me, onMe }: { me: Me; onMe: (m: Me | null) => void }): ReactElement {
  const [code, setCode] = useState(stored('dushi.code', ''));
  const [view, setView] = useState<View | null>(null);
  const [toast, setToast] = useState('');
  const [connError, setConnError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  /** 建房时要不要"人不够用 AI 补位" */
  const [aiFill, setAiFill] = useState(stored('dushi.aifill', false));
  /** 建房房规：上次用的会记住 */
  const [rules, setRules] = useState<RuleDraft>(stored('dushi.rules', DEFAULT_RULES));
  const [showStats, setShowStats] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const settledRound = useRef(0);
  const restored = useRef(false);

  const flash = (msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  useEffect(() => {
    localStorage.setItem('dushi.aifill', JSON.stringify(aiFill));
  }, [aiFill]);

  useEffect(() => {
    localStorage.setItem('dushi.rules', JSON.stringify(rules));
  }, [rules]);

  /**
   * 断线后自动重连：网络类错误退避重试（6 次，约 12 秒）；
   * 但"座位确定没了"（4212/4213/4214）不再重试 —— 那个 token 是一次性的，
   * 服务端已经不认了，再试 5 次只会在命令行刷 5 行 "reconnection token invalid or expired"。
   */
  const autoReconnect = async (room: Room): Promise<void> => {
    setReconnecting(true);
    let gone = false;
    for (let i = 0; i < 6; i++) {
      await sleep(600 + i * 500);
      try {
        const room2 = await new Client(endpoint()).reconnect(room.reconnectionToken);
        bind(room2);
        setReconnecting(false);
        setConnError('');
        return;
      } catch (e) {
        if (isGone(e)) {
          gone = true;
          break;
        }
      }
    }
    setReconnecting(false);
    sessionStorage.removeItem(TOKEN_KEY);
    setView(null);
    setConnError(gone ? '座位已经收了（离开超过 60 秒），重新进房吧' : '断线太久，座位已经收了，重新进房吧');
  };

  const bind = (room: Room): void => {
    roomRef.current = room;
    sessionStorage.setItem(TOKEN_KEY, room.reconnectionToken);
    room.onMessage('view', (v: View) => {
      setView(v);
      setConnError('');
      // 每局结算后回查一次生涯分（服务端是唯一真值，本地只做展示）
      if (v.settle && v.round !== settledRound.current) {
        settledRound.current = v.round;
        api.me().then(onMe).catch(() => undefined);
      }
    });
    room.onMessage('error', (e: { msg: string }) => flash(e.msg));
    room.onLeave((leaveCode: number) => {
      // 1000 = 自己点的"离开"，不算掉线
      if (leaveCode === 1000) {
        sessionStorage.removeItem(TOKEN_KEY);
        return;
      }
      void autoReconnect(room);
    });
    room.onError(() => setConnError('连接出错，正在尝试重连…'));
  };

  // 刷新页面：如果这个标签页刚在牌桌上，直接把座位接回来。
  // 但只在这个窗口还开着的时候试 —— 关掉标签页过夜再打开，座位早没了，
  // 硬试一次只会让服务端打一行 "reconnection token invalid or expired"。
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const tok = sessionStorage.getItem(TOKEN_KEY);
    if (!tok) return;
    const leftAt = Number(sessionStorage.getItem(LEFT_AT_KEY) ?? 0);
    if (leftAt > 0 && Date.now() - leftAt > RECONNECT_WINDOW_MS) {
      sessionStorage.removeItem(TOKEN_KEY);
      setConnError('上次那桌已经散了（离开超过 60 秒），重新进房吧');
      return;
    }
    void (async () => {
      try {
        const room = await new Client(endpoint()).reconnect(tok);
        bind(room);
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
        setConnError('上次那桌已经散了，重新进房吧');
      }
    })();
    // bind 是稳定引用（不依赖渲染状态），这里只跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 记下"页面要走"的时刻，供上面那个恢复逻辑判断窗口是否还开着
  useEffect(() => {
    const mark = (): void => {
      try {
        sessionStorage.setItem(LEFT_AT_KEY, String(Date.now()));
      } catch {
        /* 隐私模式下 sessionStorage 可能不可写，忽略 */
      }
    };
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') mark();
    };
    window.addEventListener('pagehide', mark);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', mark);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  const connect = async (roomCode: string, opts: { solo?: boolean } = {}): Promise<void> => {
    setConnError('');
    try {
      const client = new Client(endpoint());
      // 登录态走 WS 握手携带的 httpOnly cookie，这里不需要（也不该）传 token
      const solo = opts.solo === true;
      const room = await client.joinOrCreate('dushi', {
        code: roomCode,
        solo,
        aiFill: !solo && aiFill,
        rules: solo ? undefined : rules,
      });
      bind(room);
      localStorage.setItem('dushi.code', JSON.stringify(roomCode));
      setCode(roomCode);
    } catch (e) {
      const err = e as Error & { code?: number };
      const unauth = err.code === 401 || /登录|unauthor/i.test(err.message ?? '');
      setConnError(
        unauth
          ? '登录态已失效，请刷新页面重新登录'
          : `连不上服务器（${err.code ?? '网络错误'}），确认服务已启动、地址正确（同 WiFi 用局域网 IP）`,
      );
      console.error('进房失败：', err.code, err.message);
    }
  };

  const randomCode = (): string => {
    let c = '';
    for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
    return c;
  };

  const joinRoom = (): void => {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      setConnError('房号是 6 位数字');
      return;
    }
    void connect(c);
  };

  const leave = (): void => {
    roomRef.current?.leave();
    roomRef.current = null;
    sessionStorage.removeItem(TOKEN_KEY);
    setView(null);
    api.me().then(onMe).catch(() => undefined);
  };

  const logout = async (): Promise<void> => {
    roomRef.current?.leave();
    roomRef.current = null;
    sessionStorage.removeItem(TOKEN_KEY);
    setView(null);
    try {
      await api.logout();
    } finally {
      onMe(null);
    }
  };

  const send = (type: string, payload: Record<string, unknown> = {}): void => {
    roomRef.current?.send(type, payload);
  };

  if (!view) {
    return (
      <div className="lobby">
        <div className="lobby-box">
          <h1>独食</h1>
          <p className="lobby-sub">四人扑克 · ♠3♠A 是暗队友 · 打出才亮明</p>

          <div className="me-bar">
            <span className="me-name">{me.user.username}</span>
            <span className="me-career">
              生涯 <b>{me.stats.totalScore}</b> 分 · {me.stats.games} 局 {me.stats.wins} 胜
            </span>
            <button className="ghost" onClick={() => setShowStats(true)}>
              战绩
            </button>
            <button className="ghost" onClick={() => void logout()}>
              退出
            </button>
          </div>

          <button className="primary" onClick={() => void connect(randomCode())}>
            创建房间（联机）
          </button>
          <label className="opt-row">
            <input type="checkbox" checked={aiFill} onChange={(e) => setAiFill(e.target.checked)} />
            <span>人不够时让 AI 补位（有空位就能开打）</span>
          </label>
          <details className="rule-box">
            <summary>房规：{draftSummary(rules)}</summary>
            <RulesPanel value={rules} onChange={setRules} />
            <p className="hint">房规在开局后锁定，想改请开新房。</p>
          </details>
          <button onClick={() => void connect(randomCode(), { solo: true })}>单人练习 · 打 3 个 AI</button>
          <div className="join-row">
            <input
              placeholder="6 位房号"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button onClick={joinRoom} disabled={code.length !== 6}>
              加入
            </button>
          </div>
          {reconnecting && <p className="hint">断线重连中…</p>}
          {connError && <p className="err">{connError}</p>}
          <p className="hint">单人练习局不计生涯分，纯粹练手 / 熟悉牌序。</p>
          <details className="lobby-rules">
            <summary>规则速查</summary>
            <pre>{`牌大→小: 3 2 A K Q J 10 9 8 7 6 5 4
花色: ♠>♥>♣>♦   ♠3 最大 ♦4 最小
♦4 持有者先出，首手必须带 ♦4
顺子只有 4-8 到 10-A（2、3 不入顺）
同花只比花色（♠>♥>♣>♦，同花色压不动）
五张跨型: 顺<同花<三带二<四带一<同花顺
报单（剩1张）能压必须压
身份牌（♠3/♠A）单独留到最后一张出 → 判最后一名
♠3+♠A 同持=独食(1v3)；头游+12 二游-6 三四游-12`}</pre>
          </details>
        </div>
        {showStats && <Stats onClose={() => setShowStats(false)} />}
      </div>
    );
  }

  return (
    <Game
      view={view}
      toast={toast}
      connError={connError}
      send={send}
      onLeave={leave}
      flash={flash}
    />
  );
}

// ── 牌面 ────────────────────────────────────────────────

function PCard({
  card,
  selected,
  small,
  onClick,
}: {
  card: Card;
  selected?: boolean;
  small?: boolean;
  onClick?: () => void;
}): ReactElement {
  return (
    <div
      className={`pcard${small ? ' small' : ''}${selected ? ' sel' : ''}`}
      data-red={isRed(card.s)}
      onClick={onClick}
    >
      <span className="pcard-t">{card.r}</span>
      <span className="pcard-s">{SUIT_CHAR[card.s]}</span>
    </div>
  );
}

// ── 牌桌 ────────────────────────────────────────────────

function Game({
  view,
  toast,
  connError,
  send,
  onLeave,
  flash,
}: {
  view: View;
  toast: string;
  connError: string;
  send: (t: string, p?: Record<string, unknown>) => void;
  onLeave: () => void;
  flash: (m: string) => void;
}): ReactElement {
  const [picked, setPicked] = useState<number[]>([]);
  const [hintIdx, setHintIdx] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [ruleEdit, setRuleEdit] = useState(false);
  const me = view.seats[view.you];
  const hand = view.yourHand ?? [];

  useEffect(() => {
    setPicked([]);
    setHintIdx(0);
  }, [view.turn, view.trick?.seat, view.round]);

  const others = view.seats
    .map((s) => ({ s, rel: (s.seat - view.you + 4) % 4 }))
    .filter((x) => x.rel !== 0)
    .sort((a, b) => b.rel - a.rel); // 上家左、对家中、下家右

  const myTurn = view.phase === 'playing' && view.turn === view.you;
  const pickedCards = picked.map((i) => hand[i]);

  const toggle = (i: number): void => {
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
    setHintIdx(0);
  };

  const tricksForLog = view.trick;

  const doPlay = (): void => {
    if (!pickedCards.length) return;
    send('play', { cards: pickedCards.map(cardCode) });
  };

  const hints = useMemo(() => {
    if (!myTurn) return [];
    const trick = view.trick
      ? { seat: view.trick.seat, cards: view.trick.cards, pattern: classify(view.trick.cards) }
      : null;
    if (view.trick && !trick?.pattern) return [];
    try {
      return sortByPower(legalPlays(hand, trick, { mustContainD4: view.mustContainD4 }));
    } catch {
      return [];
    }
  }, [myTurn, hand, view.trick, view.mustContainD4]);

  const applyHint = (): void => {
    if (hints.length === 0) {
      flash('没有能压过的牌');
      return;
    }
    const h = hints[hintIdx % hints.length];
    setHintIdx((x) => x + 1);
    setPicked(
      h.cards
        .map((c) => hand.findIndex((hc) => hc.s === c.s && hc.r === c.r))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b),
    );
  };

  const submitDeclare = (choice: 'none' | 'baiPai' | 'surrender'): void => send('declare', { choice });

  return (
    <div className="table">
      <header className="bar">
        <span>
          房号 <b>{view.roomCode}</b>
          {view.practice && <em className="tag practice">练习</em>}
          {view.hasAi && !view.practice && <em className="tag practice">有 AI</em>}
        </span>
        <span className="round">{view.round > 0 ? view.match.label : '等待玩家'}</span>
        <button className="ghost" onClick={() => setLogOpen((o) => !o)}>
          记录
        </button>
        <button className="ghost" onClick={onLeave}>
          离开
        </button>
      </header>
      <div className="rulesnote">{view.rulesNote}</div>

      {connError && <div className="banner">{connError}</div>}
      {toast && <div className="banner toast">{toast}</div>}

      <section className="oppbar">
        {others.map(({ s, rel }) => (
          <SeatChip key={s.seat} s={s} rel={rel} isTurn={view.turn === s.seat} you={view.you} />
        ))}
      </section>

      <section className="center">
        {tricksForLog ? (
          <div className="trick">
            <div className="trick-who">
              {view.seats[tricksForLog.seat].name} 出 · {tricksForLog.cat}
            </div>
            <div className="trick-cards">
              {tricksForLog.cards.map((c, i) => (
                <PCard key={i} card={c} small />
              ))}
            </div>
          </div>
        ) : (
          <div className="trick empty">
            {view.phase === 'waiting'
              ? '凑满 4 人并点"准备"即可开局'
              : myTurn && !view.trick
                ? '新一轮：出任意牌型'
                : '等待新一轮出牌…'}
          </div>
        )}
      </section>

      <section className="myarea">
        <div className="myrow">
          <span className="myname">
            {me.name}（{hand.length} 张）
            {me.revealed && <em className="tag">⚑ 已亮</em>}
            {myTurn && <em className="tag turn">思考中…</em>}
          </span>
          <span className="score">
            本场 {view.scores[view.you]}
            {me.career !== null && <em className="career">生涯 {me.career}</em>}
          </span>
        </div>
        <div className="hand">
          {hand.map((c, i) => (
            <PCard key={`${c.s}${c.r}`} card={c} selected={picked.includes(i)} onClick={() => myTurn && toggle(i)} />
          ))}
        </div>
        <div className="actions">
          <button onClick={applyHint} disabled={!myTurn}>
            提示
          </button>
          <button
            onClick={() => send('pass')}
            disabled={!myTurn || !view.canPass || !!view.trick === false}
          >
            不出
          </button>
          <button className="primary" onClick={doPlay} disabled={!myTurn || pickedCards.length === 0}>
            出牌
          </button>
        </div>
      </section>

      {logOpen && (
        <div className="log" onClick={() => setLogOpen(false)}>
          {view.eventLog.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {view.declareAsk && (
        <div className="modal">
          <div className="modal-box">
            <h3>你是独食者</h3>
            <p>♠3 和 ♠A 都在你手里，一人打三家。头游 +12、二游 −6、三四游 −12、投降 −12。如何开始？</p>
            <button className="primary" onClick={() => submitDeclare('none')}>
              不表态（暗打）
            </button>
            <button onClick={() => submitDeclare('baiPai')}>摆牌（分数翻倍）</button>
            <button onClick={() => submitDeclare('surrender')}>投降（−12）</button>
          </div>
        </div>
      )}

      {view.baiPaiHand && view.phase !== 'settling' && (
        <div className="baipai">
          摆牌公开：{view.baiPaiHand.map((c) => `${SUIT_CHAR[c.s]}${c.r}`).join(' ')}
        </div>
      )}

      {view.settle && (
        <div className="modal">
          <div className="modal-box">
            <h3>结算 · {view.settle.reason}</h3>
            <table>
              <tbody>
                {view.seats.map((s) => {
                  const delta = view.settle!.deltas[s.seat];
                  const careerDelta = view.careerDelta[s.seat] ?? 0;
                  return (
                    <tr key={s.seat}>
                      <td>
                        {s.name}
                        {s.identityLast && <em className="tag warn">身份牌留手</em>}
                      </td>
                      <td>{PLACE_NAMES[s.place ?? 0] ?? ''}</td>
                      <td className={delta >= 0 ? 'plus' : 'minus'}>
                        {delta > 0 ? `+${delta}` : delta === 0 ? '±0' : delta}
                      </td>
                      <td className="dim">
                        本场 {view.scores[s.seat]}
                        {careerDelta !== 0 && (
                          <span className={careerDelta > 0 ? 'plus' : 'minus'}>
                            {' '}
                            / 生涯 {careerDelta > 0 ? '+' : ''}
                            {careerDelta}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {view.settle.soloSeat !== null && (
              <p className="dim">独食者：{view.seats[view.settle.soloSeat].name}</p>
            )}
            {(view.practice || view.hasAi) && (
              <p className="dim">{view.practice ? '练习局' : '本局有 AI 补位'} · 不计生涯分</p>
            )}
            {!view.match.over && view.you === 0 && (
              <button className="primary" onClick={() => send('nextRound')}>
                开始下一局
              </button>
            )}
            {!view.match.over && view.you !== 0 && <p className="dim">等待房主开始下一局…</p>}
            {!view.match.over && view.you === 0 && view.match.mode === 'endless' && (
              <button onClick={() => send('endMatch')}>结束本场</button>
            )}
            {view.match.over && (
              <>
                <p className="primary-text">🏆 本场结束（{view.match.label}），总分见上！</p>
                <button className="primary" onClick={onLeave}>
                  返回大厅
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {view.phase === 'waiting' && (
        <div className="modal">
          <div className="modal-box">
            <h3>{view.emptySeats > 0 ? `还差 ${view.emptySeats} 人` : '人齐了'}</h3>
            <p className="dim">
              已到 {4 - view.emptySeats}/4：
              {view.seats
                .filter((s) => s.name !== '空位')
                .map((s) => s.name)
                .join('、')}
            </p>

            <p className="dim">房规：{view.rules.summary}</p>
            {view.you === 0 && view.round === 0 ? (
              <>
                <button className="ghost" onClick={() => setRuleEdit((v) => !v)}>
                  {ruleEdit ? '收起房规' : '改房规'}
                </button>
                {ruleEdit && (
                  <RulesPanel value={view.rules} onChange={(next) => send('setRules', { rules: next })} />
                )}
              </>
            ) : (
              view.round > 0 && <p className="hint">房规已锁定（开局后不可改）</p>
            )}

            {view.emptySeats === 0 ? (
              <button className="primary" onClick={() => send('ready', { ready: true })}>
                准备开局
              </button>
            ) : view.aiFill ? (
              view.you === 0 ? (
                <>
                  <button className="primary" onClick={() => send('fillAi')}>
                    AI 补位开局（补 {view.emptySeats} 个）
                  </button>
                  <p className="dim">也可以继续等人，人来齐了点"准备"正常开。</p>
                </>
              ) : (
                <p className="dim">等房主决定是否叫 AI 补位，或继续等人。</p>
              )
            ) : (
              <p className="dim">这个房间建房时没开 AI 补位，只能等人。</p>
            )}

            <p className="hint">房号 {view.roomCode} · 发给朋友就能进</p>
          </div>
        </div>
      )}
    </div>
  );
}

function SeatChip({ s, rel, isTurn }: { s: SeatView; rel: number; isTurn: boolean; you: number }): ReactElement {
  const seatName = ['', '下家', '对家', '上家'] as const;
  const empty = s.name === '空位';
  return (
    <div
      className={`chip${isTurn ? ' turn' : ''}${!s.connected && !empty ? ' off' : ''}${empty ? ' empty-seat' : ''}${
        s.bot ? ' bot' : ''
      }`}
    >
      <div className="chip-head">
        <b>{s.name}</b>
        <span className="dim">{seatName[rel]}</span>
        {s.revealed && <em className="tag">⚑</em>}
      </div>
      <div className="chip-body">
        <span className="cards-left">{empty ? '等待加入' : `${s.cards} 张`}</span>
        {s.place !== null && <span className="place">{PLACE_NAMES[s.place]}</span>}
        {!s.connected && !empty && <span className="off-tag">断线</span>}
        {s.bot && <span className="bot-tag">AI</span>}
      </div>
      {s.career !== null && <div className="chip-career">生涯 {s.career}</div>}
    </div>
  );
}
