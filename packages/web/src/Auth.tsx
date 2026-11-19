/**
 * 登录 / 注册页（单页两输入框 + 一个按钮，设计文档 §7.2 "登录"一条）。
 * 登录态由服务端 cookie 维持 7 天，刷新页面不需要再输密码。
 *
 * 注册模式下用户名边打边查重（400ms 防抖）：本地先过格式，再问服务端有没有被占。
 * 这只是体验优化 —— 真正防重复的是服务端唯一约束，提交时若被人抢先注册，仍会拿到 409。
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from './api.ts';
import type { Me } from './api.ts';

type NameState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'unknown';

const NAME_RE = /^[\p{L}\p{N}_-]{2,16}$/u;

export function Auth({ onDone }: { onDone: (me: Me) => void }): ReactElement {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [nameState, setNameState] = useState<NameState>('idle');
  const [nameMsg, setNameMsg] = useState('');

  // 注册模式下防抖查重；切回登录、改名字、关页面都要让旧请求作废，避免慢响应覆盖新结果
  useEffect(() => {
    if (mode !== 'register') {
      setNameState('idle');
      setNameMsg('');
      return;
    }
    const name = username.trim();
    if (name.length < 2) {
      setNameState('idle');
      setNameMsg('');
      return;
    }
    if (!NAME_RE.test(name)) {
      setNameState('invalid');
      setNameMsg('只能用中英文、数字、下划线，2–16 个字符');
      return;
    }

    let alive = true;
    setNameState('checking');
    setNameMsg('');
    const timer = setTimeout(async () => {
      try {
        const r = await api.checkUsername(name);
        if (!alive) return;
        if (r.available) {
          setNameState('free');
          setNameMsg('这个名字可以用');
        } else {
          setNameState(r.reason === 'invalid' ? 'invalid' : 'taken');
          setNameMsg(r.error ?? '这个名字不能用');
        }
      } catch {
        // 查不动就不挡路：交给提交时的服务端校验兜底
        if (!alive) return;
        setNameState('unknown');
        setNameMsg('');
      }
    }, 400);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [username, mode]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const me = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
      onDone(me);
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      if (mode === 'register' && /占用/.test(msg)) {
        setNameState('taken');
        setNameMsg(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  // 注册时"名字没确认可用"就不让提交，省得点了才挨骂
  const nameOk = mode === 'login' || nameState === 'free' || nameState === 'unknown';
  const canSubmit = username.trim().length >= 2 && password.length >= 6 && nameOk && !busy;
  const noteClass =
    nameState === 'free' ? 'note ok' : nameState === 'taken' || nameState === 'invalid' ? 'note bad' : 'note';

  return (
    <div className="lobby">
      <form
        className="lobby-box auth-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>独食</h1>
        <p className="lobby-sub">四人扑克 · ♠3♠A 是暗队友 · 打出才亮明</p>

        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
            登录
          </button>
          <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
            注册
          </button>
        </div>

        <input
          placeholder={mode === 'register' ? '起个名字（2–16 字）' : '用户名'}
          value={username}
          maxLength={16}
          autoComplete="username"
          autoCapitalize="none"
          aria-invalid={nameState === 'taken' || nameState === 'invalid'}
          onChange={(e) => setUsername(e.target.value)}
        />
        {mode === 'register' && nameState !== 'idle' && (
          <p className={noteClass}>
            {nameState === 'checking' ? '查一下这个名字…' : nameState === 'free' ? `✓ ${nameMsg}` : nameMsg}
          </p>
        )}

        <input
          type="password"
          placeholder={mode === 'register' ? '设个密码（至少 6 位）' : '密码'}
          value={password}
          maxLength={128}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)}
        />

        {err && <p className="err">{err}</p>}

        <button className="primary" type="submit" disabled={!canSubmit}>
          {busy ? '请稍等…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <p className="hint">
          {mode === 'login'
            ? '没有账号？点上面的「注册」，不用手机号也不用邮箱。'
            : '账号只为了方便记生涯分，昵称就是你的用户名。'}
        </p>

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
      </form>
    </div>
  );
}
