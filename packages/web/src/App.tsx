import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { classify, legalPlays, sortByPower } from '@dushi/rules';
import type { Card } from '@dushi/rules';
import { SUIT_CHAR, isRed, cardCode, PLACE_NAMES } from './view.ts';
import type { View, SeatView } from './view.ts';

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

export function App(): ReactElement {
  const [name, setName] = useState(stored('dushi.name', ''));
  const [code, setCode] = useState(stored('dushi.code', ''));
  const [view, setView] = useState<View | null>(null);
  const [toast, setToast] = useState('');
  const [connError, setConnError] = useState('');
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    localStorage.setItem('dushi.name', JSON.stringify(name));
  }, [name]);

  const flash = (msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const bind = (room: Room): void => {
    roomRef.current = room;
    room.onMessage('view', (v: View) => {
      setView(v);
      setConnError('');
    });
    room.onMessage('error', (e: { msg: string }) => flash(e.msg));
    room.onLeave(() => setConnError('已断开连接，刷新页面重新进房'));
    room.onError(() => setConnError('连接出错，请检查网络后刷新'));
    if (name.trim()) room.send('setName', { name: name.trim() });
  };

  const connect = async (roomCode: string): Promise<void> => {
    setConnError('');
    try {
      const client = new Client(endpoint());
      const room = await client.joinOrCreate('dushi', { code: roomCode });
      bind(room);
      localStorage.setItem('dushi.code', JSON.stringify(roomCode));
      setCode(roomCode);
    } catch (e) {
      setConnError('连不上服务器，确认服务已启动、地址正确（同 WiFi 用局域网 IP）');
      console.error(e);
    }
  };

  const createRoom = (): void => {
    let c = '';
    for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
    void connect(c);
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
    setView(null);
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
          <input
            placeholder="昵称"
            value={name}
            maxLength={12}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary" onClick={createRoom} disabled={!name.trim()}>
            创建房间
          </button>
          <div className="join-row">
            <input
              placeholder="6 位房号"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button onClick={joinRoom} disabled={!name.trim() || code.length !== 6}>
              加入
            </button>
          </div>
          {connError && <p className="err">{connError}</p>}
          <details className="lobby-rules">
            <summary>规则速查</summary>
            <pre>{`牌大→小: 3 2 A K Q J 10 9 8 7 6 5 4
花色: ♠>♥>♣>♦   ♠3 最大 ♦4 最小
♦4 持有者先出，首手必须带 ♦4
顺子只有 4-8 到 10-A（2、3 不入顺）
同花只比花色（♠>♥>♣>♦，同花色压不动）
五张跨型: 顺<同花<三带二<四带一<同花顺
报单（剩1张）能压必须压
♠3+♠A 同持=独食(1v3)，必须头游才赢`}</pre>
          </details>
        </div>
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
        </span>
        <span className="round">{view.round > 0 ? `第 ${view.round} 局` : '等待玩家'}</span>
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
          <span className="score">本场 {view.scores[view.you]}</span>
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
            <p>♠3 和 ♠A 都在你手里，一人打三家。必须头游才算赢。如何开始？</p>
            <button className="primary" onClick={() => submitDeclare('none')}>
              不表态（暗打）
            </button>
            <button onClick={() => submitDeclare('baiPai')}>摆牌（分数翻倍）</button>
            <button onClick={() => submitDeclare('surrender')}>投降（−3）</button>
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
                  return (
                    <tr key={s.seat}>
                      <td>{s.name}</td>
                      <td>{PLACE_NAMES[s.place ?? 0] ?? ''}</td>
                      <td className={delta >= 0 ? 'plus' : 'minus'}>
                        {delta > 0 ? `+${delta}` : delta === 0 ? '±0' : delta}
                      </td>
                      <td className="dim">本场 {view.scores[s.seat]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {view.settle.soloSeat !== null && (
              <p className="dim">独食者：{view.seats[view.settle.soloSeat].name}</p>
            )}
            {view.you === 0 && view.round < 8 && (
              <button className="primary" onClick={() => send('nextRound')}>
                开始下一局
              </button>
            )}
            {view.you !== 0 && view.round < 8 && <p className="dim">等待房主开始下一局…</p>}
            {view.round >= 8 && <p className="primary-text">🏆 全场结束，总分见上！</p>}
          </div>
        </div>
      )}

      {view.phase === 'waiting' && view.seats.some((s) => !s.connected) === false && (
        <div className="modal">
          <div className="modal-box">
            <h3>人齐了</h3>
            <button className="primary" onClick={() => send('ready', { ready: true })}>
              准备开局
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SeatChip({ s, rel, isTurn }: { s: SeatView; rel: number; isTurn: boolean; you: number }): ReactElement {
  const seatName = ['', '下家', '对家', '上家'] as const;
  return (
    <div className={`chip${isTurn ? ' turn' : ''}${!s.connected ? ' off' : ''}`}>
      <div className="chip-head">
        <b>{s.name}</b>
        <span className="dim">{seatName[rel]}</span>
        {s.revealed && <em className="tag">⚑</em>}
      </div>
      <div className="chip-body">
        <span className="cards-left">{s.cards} 张</span>
        {s.place !== null && <span className="place">{PLACE_NAMES[s.place]}</span>}
        {!s.connected && <span className="off-tag">断线</span>}
      </div>
    </div>
  );
}
