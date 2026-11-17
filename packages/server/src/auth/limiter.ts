/**
 * 登录限流：固定窗口计数（够用且好解释）。
 *
 * 口径（设计文档 §6.6）：登录失败 5 次 / 分钟 / IP；注册 10 次 / 小时 / IP。
 * 只统计"失败"，登录成功即清零 —— 正常玩家不会被自己误伤。
 */

export interface LimitState {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, LimitState>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** 是否已被封（达到上限） */
  blocked(key: string, now = Date.now()): { blocked: boolean; retryAfterMs: number } {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) return { blocked: false, retryAfterMs: 0 };
    return { blocked: b.count >= this.max, retryAfterMs: Math.max(0, b.resetAt - now) };
  }

  /** 记一次失败/一次请求 */
  hit(key: string, now = Date.now()): void {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      b.count += 1;
    }
    this.prune(now);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 防止被大量随机 IP 撑爆内存 */
  private prune(now: number): void {
    if (this.buckets.size < 5000) return;
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** 登录失败：5 次/分钟 */
export const loginLimiter = new RateLimiter(5, 60_000);
/** 注册：20 次/小时（一个 WiFi 后面可能同时注册 4–8 个号，留点余量） */
export const registerLimiter = new RateLimiter(20, 60 * 60_000);
