/**
 * 牌桌音效 —— 全部用 WebAudio 现场合成，**不带任何音频文件**。
 *
 * 为什么不用 mp3：
 *  - 版权。这类地方棋牌的音效是有版权的，不用别人的素材是最省事的做法。
 *  - 体积与失败面。"出牌 / 不出 / 亮身份 / 宣告 / 轮到我 / 结算"六个音，
 *    素材至少几十 KB，还要预加载、还要处理加载失败；合成音的素材体积是 0。
 *  - 好调。改个频率就是另一个音色，试听成本几乎为零。
 *
 * 两个必须扛住的坑：
 *  1. iOS / Chrome 的自动播放策略要求 AudioContext 在**用户手势里**创建或 resume，
 *     否则一直是 suspended。所以这里懒创建，并且在每次调用时尝试 resume；
 *     失败就静默降级 —— 绝不能因为没声音让牌桌点不动。
 *  2. 静音状态记在 localStorage，刷新后保持。
 */

export type SfxKind = 'play' | 'pass' | 'reveal' | 'declare' | 'turn' | 'win' | 'lose';

const MUTE_KEY = 'dushi.mute';

let ctx: AudioContext | null = null;
let muted = false;

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  /* 隐私模式下 localStorage 可能不可写 */
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean): void {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}

function ac(): AudioContext | null {
  if (muted) return null;
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 一个带包络的音：起音很快、指数衰减，听感像"敲一下"而不是"拉长音" */
function tone(
  c: AudioContext,
  opts: {
    freq: number;
    to?: number;
    dur: number;
    type?: OscillatorType;
    gain?: number;
    delay?: number;
  },
): void {
  const t0 = c.currentTime + (opts.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + opts.dur);

  const peak = (opts.gain ?? 0.2) * 0.35;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);

  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.02);
}

/** 一小段噪声爆破：纸牌拍在桌上的"啪" */
function thud(c: AudioContext, dur = 0.06, gain = 0.5): void {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;

  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1200;
  const g = c.createGain();
  g.gain.value = gain * 0.35;
  src.connect(lp).connect(g).connect(c.destination);
  src.start();
}

export function sfx(kind: SfxKind): void {
  const c = ac();
  if (!c) return;
  switch (kind) {
    case 'play':
      thud(c, 0.06, 0.55);
      tone(c, { freq: 190, to: 120, dur: 0.08, type: 'triangle', gain: 0.18 });
      break;
    case 'pass':
      tone(c, { freq: 200, to: 110, dur: 0.12, type: 'sine', gain: 0.14 });
      break;
    case 'reveal':
      tone(c, { freq: 880, dur: 0.3, type: 'triangle', gain: 0.2 });
      tone(c, { freq: 1320, dur: 0.28, type: 'sine', gain: 0.12, delay: 0.02 });
      break;
    case 'declare':
      thud(c, 0.09, 0.5);
      tone(c, { freq: 90, to: 70, dur: 0.22, type: 'sine', gain: 0.3 });
      break;
    case 'turn':
      tone(c, { freq: 1200, dur: 0.035, type: 'square', gain: 0.06 });
      break;
    case 'win':
      tone(c, { freq: 523, dur: 0.16, type: 'triangle', gain: 0.18 });
      tone(c, { freq: 784, dur: 0.24, type: 'triangle', gain: 0.18, delay: 0.14 });
      break;
    case 'lose':
      tone(c, { freq: 392, dur: 0.18, type: 'triangle', gain: 0.16 });
      tone(c, { freq: 262, dur: 0.26, type: 'triangle', gain: 0.16, delay: 0.15 });
      break;
  }
}
