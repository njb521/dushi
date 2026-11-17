/**
 * 账号接口的薄封装。服务端所有错误都是 `{ error: "人话" }`，这里统一抛成 Error，
 * 界面直接显示 message —— 不需要在组件里再判断状态码。
 */

export interface Stats {
  totalScore: number;
  games: number;
  wins: number;
  soloGames: number;
  soloWins: number;
  bestStreak: number;
}

export interface Me {
  user: { id: number; username: string };
  stats: Stats;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 空响应 */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  me: (): Promise<Me> => call<Me>('/api/me'),
  register: (username: string, password: string): Promise<Me> =>
    call<Me>('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string): Promise<Me> =>
    call<Me>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: (): Promise<void> => call<void>('/api/logout', { method: 'POST' }),
  changePassword: (oldPassword: string, newPassword: string): Promise<Me> =>
    call<Me>('/api/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),
};
