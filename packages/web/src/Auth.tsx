/**
 * 登录 / 注册页（单页两输入框 + 一个按钮，设计文档 §7.2 "登录"一条）。
 * 登录态由服务端 cookie 维持 7 天，刷新页面不需要再输密码。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { api } from './api.ts';
import type { Me } from './api.ts';

export function Auth({ onDone }: { onDone: (me: Me) => void }): ReactElement {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const me = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
      onDone(me);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = username.trim().length >= 2 && password.length >= 6 && !busy;

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
          onChange={(e) => setUsername(e.target.value)}
        />
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
♠3+♠A 同持=独食(1v3)，必须头游才赢`}</pre>
        </details>
      </form>
    </div>
  );
}
