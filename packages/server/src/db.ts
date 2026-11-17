/**
 * 数据层：SQLite（`node:sqlite`，Node 22 内置）。
 *
 * 为什么用内置 SQLite 而不是 better-sqlite3：本项目对依赖极简，账号数据量小（好友局级别），
 * 一个进程一个库文件足够；内置模块免去 Windows 上的原生编译。表结构与设计文档 §6.6 一致。
 *
 * 落盘位置：<repo>/data/dushi.db（可用 DUSHI_DATA_DIR 覆盖，测试用临时目录隔离）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const DATA_DIR = process.env.DUSHI_DATA_DIR ?? join(HERE, '..', '..', '..', 'data');
export const DB_FILE = join(DATA_DIR, 'dushi.db');

/** 当前 schema 版本，递增即触发迁移 */
const SCHEMA_VERSION = 1;

export interface UserRow {
  id: number;
  username: string;
  pass_hash: string;
  token_version: number;
  created_at: number;
  last_login: number | null;
}

export interface StatsRow {
  user_id: number;
  total_score: number;
  games: number;
  wins: number;
  solo_games: number;
  solo_wins: number;
  updated_at: number;
}

export interface RoundResultInput {
  matchId: number;
  roundNo: number;
  userId: number;
  seat: number;
  place: number | null;
  isSolo: boolean;
  declared: 'none' | 'baiPai' | 'surrender' | null;
  delta: number;
}

let db: DatabaseSync | null = null;

export function openDb(file = DB_FILE): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 3000');
  migrate(conn);
  db = conn;
  return conn;
}

export function getDb(): DatabaseSync {
  return db ?? openDb();
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function migrate(conn: DatabaseSync): void {
  const row = conn.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version >= SCHEMA_VERSION) return;

  if (version < 1) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
        pass_hash     TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        last_login    INTEGER
      );

      CREATE TABLE IF NOT EXISTS matches (
        id         INTEGER PRIMARY KEY,
        room_code  TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        seed       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS match_players (
        id         INTEGER PRIMARY KEY,
        match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        round_no   INTEGER NOT NULL,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seat       INTEGER NOT NULL,
        place      INTEGER,
        is_solo    INTEGER NOT NULL DEFAULT 0,
        declared   TEXT,
        delta      INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id, round_no);

      CREATE TABLE IF NOT EXISTS user_stats (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        total_score INTEGER NOT NULL DEFAULT 0,
        games       INTEGER NOT NULL DEFAULT 0,
        wins        INTEGER NOT NULL DEFAULT 0,
        solo_games  INTEGER NOT NULL DEFAULT 0,
        solo_wins   INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT 0
      );
    `);
    conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** 事务包装：异常时回滚 */
function tx<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

const num = (v: unknown): number => Number(v ?? 0);

// ── 用户 ────────────────────────────────────────────────

/** 创建用户；用户名已被占用时返回 null（不抛错，靠 UNIQUE 约束兜底并发） */
export function createUser(username: string, passHash: string): UserRow | null {
  const conn = getDb();
  const ts = nowSec();
  try {
    const info = conn
      .prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passHash, ts);
    const id = num(info.lastInsertRowid);
    conn.prepare('INSERT INTO user_stats (user_id, updated_at) VALUES (?, ?)').run(id, ts);
    return findUserById(id);
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) return null;
    throw e;
  }
}

export function findUserByName(username: string): UserRow | null {
  const row = getDb()
    .prepare(
      'SELECT id, username, pass_hash, token_version, created_at, last_login FROM users WHERE username = ?',
    )
    .get(username);
  return (row as UserRow | undefined) ?? null;
}

export function findUserById(id: number): UserRow | null {
  const row = getDb()
    .prepare(
      'SELECT id, username, pass_hash, token_version, created_at, last_login FROM users WHERE id = ?',
    )
    .get(id);
  return (row as UserRow | undefined) ?? null;
}

export function touchLogin(id: number): void {
  getDb().prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowSec(), id);
}

/** 改密码：同时递增 token_version，使旧 JWT 全部失效 */
export function updatePassword(id: number, passHash: string): void {
  getDb()
    .prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(passHash, id);
}

// ── 统计 ────────────────────────────────────────────────

export function getStats(userId: number): StatsRow {
  const row = getDb()
    .prepare(
      'SELECT user_id, total_score, games, wins, solo_games, solo_wins, updated_at FROM user_stats WHERE user_id = ?',
    )
    .get(userId) as StatsRow | undefined;
  return (
    row ?? {
      user_id: userId,
      total_score: 0,
      games: 0,
      wins: 0,
      solo_games: 0,
      solo_wins: 0,
      updated_at: 0,
    }
  );
}

export function careerOf(userId: number): number {
  return getStats(userId).total_score;
}

export function leaderboard(limit = 10): { username: string; total_score: number; games: number; wins: number }[] {
  return getDb()
    .prepare(
      `SELECT u.username, s.total_score, s.games, s.wins
         FROM user_stats s JOIN users u ON u.id = s.user_id
        WHERE s.games > 0
        ORDER BY s.total_score DESC, s.wins DESC
        LIMIT ?`,
    )
    .all(limit) as { username: string; total_score: number; games: number; wins: number }[];
}

// ── 场次 ────────────────────────────────────────────────

export function createMatch(roomCode: string, rulesJson: string, seed: number): number {
  const info = getDb()
    .prepare('INSERT INTO matches (room_code, rules_json, started_at, seed) VALUES (?, ?, ?, ?)')
    .run(roomCode, rulesJson, nowSec(), seed);
  return num(info.lastInsertRowid);
}

export function endMatch(matchId: number): void {
  getDb().prepare('UPDATE matches SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(nowSec(), matchId);
}

/**
 * 记录一局结果并累加生涯分（同一事务：match_players 插入 + user_stats 更新）。
 * 返回该用户更新后的生涯分。
 */
export function recordRound(results: RoundResultInput[]): Map<number, number> {
  const conn = getDb();
  const ts = nowSec();
  const out = new Map<number, number>();
  if (results.length === 0) return out;

  tx(conn, () => {
    const ins = conn.prepare(
      `INSERT INTO match_players
         (match_id, round_no, user_id, seat, place, is_solo, declared, delta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upd = conn.prepare(
      `INSERT INTO user_stats (user_id, total_score, games, wins, solo_games, solo_wins, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         total_score = total_score + excluded.total_score,
         games       = games + 1,
         wins        = wins + excluded.wins,
         solo_games  = solo_games + excluded.solo_games,
         solo_wins   = solo_wins + excluded.solo_wins,
         updated_at  = excluded.updated_at`,
    );

    for (const r of results) {
      ins.run(
        r.matchId,
        r.roundNo,
        r.userId,
        r.seat,
        r.place,
        r.isSolo ? 1 : 0,
        r.declared,
        r.delta,
        ts,
      );
      const win = r.place === 1 ? 1 : 0;
      upd.run(r.userId, r.delta, win, r.isSolo ? 1 : 0, r.isSolo && win ? 1 : 0, ts);
    }

    const read = conn.prepare('SELECT total_score FROM user_stats WHERE user_id = ?');
    for (const r of results) {
      const row = read.get(r.userId) as { total_score: number } | undefined;
      out.set(r.userId, num(row?.total_score));
    }
  });

  return out;
}

export interface MatchHistoryRow {
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

export function recentRounds(userId: number, limit = 20): MatchHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT mp.id, mp.match_id, mp.round_no, mp.seat, mp.place, mp.is_solo, mp.declared,
              mp.delta, mp.created_at, m.room_code
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = ?
        ORDER BY mp.id DESC
        LIMIT ?`,
    )
    .all(userId, limit) as MatchHistoryRow[];
}
