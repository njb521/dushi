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

export interface NameCheck {
  available: boolean;
  reason?: 'invalid' | 'taken';
  error?: string;
}

export interface RoundRow {
  id: number;
  match_id: number;
  round_no: number;
  seat: number;
  place: number | null;
  is_solo: number;
  declared: string | null;
  delta: number;
  created_at: number;
  room_code: string;
}

export interface HistoryPage {
  rows: RoundRow[];
  nextCursor: number | null;
}

export interface Summary {
  totalScore: number;
  games: number;
  wins: number;
  winRate: number;
  soloGames: number;
  soloWins: number;
  bestDelta: number;
  last7d: { date: string; delta: number }[];
}

export interface BoardRow {
  username: string;
  total_score: number;
  games: number;
  wins: number;
}

export interface Board {
  rows: BoardRow[];
  me: { rank: number | null; username: string; totalScore: number; games: number; wins: number };
}

export const api = {
  me: (): Promise<Me> => call<Me>('/api/me'),
  register: (username: string, password: string): Promise<Me> =>
    call<Me>('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string): Promise<Me> =>
    call<Me>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: (): Promise<void> => call<void>('/api/logout', { method: 'POST' }),
  /** 注册页边打边查：这个用户名能不能用 */
  checkUsername: (name: string): Promise<NameCheck> =>
    call<NameCheck>(`/api/username-available?name=${encodeURIComponent(name)}`),
  /** 最近对局（游标分页，before = 上一页最后一条 id） */
  history: (before?: number): Promise<HistoryPage> =>
    call<HistoryPage>(`/api/history${before ? `?before=${before}` : ''}`),
  summary: (): Promise<Summary> => call<Summary>('/api/stats/summary'),
  leaderboard: (): Promise<Board> => call<Board>('/api/leaderboard'),
  changePassword: (oldPassword: string, newPassword: string): Promise<Me> =>
    call<Me>('/api/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),
};
