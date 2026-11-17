/**
 * 命令行人机对战：你坐一个位置，另外三家是简单 AI。
 *
 *   npm run play                 # 随机种子
 *   npm run play -- --seed=42    # 固定种子（可回放）
 *   npm run play -- --seat=2     # 换个座位
 */

import { createInterface } from 'node:readline';
import { stdin, stdout, exit } from 'node:process';
import type { Card } from '../src/cards.ts';
import { cardLabel } from '../src/cards.ts';
import type { GameState } from '../src/game.ts';
import {
  canPass,
  createGame,
  declare,
  PLACE_NAMES,
  pass,
  play,
  settle,
  validatePlay,
} from '../src/game.ts';
import { chooseAction } from '../src/ai.ts';
import { legalPlays, sortByPower } from '../src/plays.ts';
import { patternName } from '../src/pattern.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=?(.*)$/.exec(a);
  if (m) args.set(m[1], m[2]);
}

if (args.has('help')) {
  console.log(`用法：npm run play [-- --seed=42] [-- --seat=0..3]`);
  exit(0);
}

const mySeat = Math.min(3, Math.max(0, Number(args.get('seat') ?? 0)));
const seedArg = args.get('seed');
const seed = seedArg ? Number(seedArg) : Math.floor(Math.random() * 1e9);
/** 四家全 AI，用来快速看一局走的流程 */
const allBot = args.has('bot');
const NAMES = ['你', '阿良', '小陈', '老王'];

const state: GameState = createGame(NAMES, seed);
for (let i = 0; i < 4; i++) state.seats[i].name = i === mySeat ? '你' : NAMES[i];

// ── 输入 ────────────────────────────────────────────────
const rl = createInterface({ input: stdin, output: stdout });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt: string): Promise<string | null> {
  stdout.write(prompt);
  const r = await lines.next();
  if (r.done) return null;
  return String(r.value).trim();
}

function quit(code = 0): never {
  rl.close();
  exit(code);
}

// ── 渲染 ────────────────────────────────────────────────
const RULE = '─'.repeat(62);

function seatLine(s: GameState['seats'][number]): string {
  const bits = [s.name];
  if (s.place !== null) bits.push(`[${PLACE_NAMES[s.place]}]`);
  bits.push(`${s.hand.length} 张`);
  if (s.revealed) bits.push('⚑');
  return bits.join(' ');
}

function render(): void {
  console.log(`\n${RULE}`);
  const tags = [state.soloSeat !== null ? '独食局' : '二打二'];
  if (state.baiPai) tags.push('摆牌');
  console.log(`种子 ${seed}   座位 ${mySeat}   ${tags.join(' / ')}`);
  console.log(state.seats.map(seatLine).join('   '));
  if (state.trick) {
    const owner = state.seats[state.trick.seat].name;
    console.log(
      `上一手：${state.trick.cards.map(cardLabel).join(' ')}（${patternName(state.trick.pattern)}）by ${owner}`,
    );
  } else {
    console.log('上一手：无（新一轮，可任意出牌）');
  }

  const me = state.seats[mySeat];
  console.log(`\n你的手牌（${me.hand.length} 张）：`);
  const width = String(me.hand.length).length;
  const items = me.hand.map((c, i) => `${String(i + 1).padStart(width)}:${cardLabel(c)}`);
  for (let i = 0; i < items.length; i += 7) console.log('  ' + items.slice(i, i + 7).join('  '));
  console.log('');
}

function showHints(): void {
  const me = state.seats[mySeat];
  const must = !state.firstPlayDone && state.requireD4;
  const opts = sortByPower(legalPlays(me.hand, state.trick, { mustContainD4: must }));
  if (opts.length === 0) {
    console.log('  没有能压过的牌，只能不出（输入 p）。');
    return;
  }
  console.log(`  可出 ${opts.length} 种，前 8 个：`);
  for (const o of opts.slice(0, 8)) {
    const idx = o.cards.map((c) => me.hand.findIndex((h) => h.s === c.s && h.r === c.r) + 1);
    console.log(`   ${idx.join(' ').padEnd(12)} → ${o.cards.map(cardLabel).join(' ')}（${patternName(o.pattern)}）`);
  }
}

// ── 独食宣告 ────────────────────────────────────────────
if (state.phase === 'declaring') {
  if (state.soloSeat === mySeat) {
    console.log(`\n你是独食者（手里有 ♠3 和 ♠A），一人打三家。`);
    console.log('  n = 不表态（正常打：头游 +12 / 二游 -6 / 三四游 -12）');
    console.log('  b = 摆牌（手牌全部公开，分数翻倍：头游 +24，二游 -12，三四游 -24）');
    console.log('  s = 投降（-12 分，三家各 +4）');
    for (;;) {
      const a = (await ask('选择 n/b/s > '))?.toLowerCase();
      if (a === null) quit();
      if (a === 'n' || a === 'none') { declare(state, 'none'); break; }
      if (a === 'b' || a === 'baipai') { declare(state, 'baiPai'); break; }
      if (a === 's' || a === 'surrender') { declare(state, 'surrender'); break; }
      console.log('  请输入 n / b / s');
    }
  } else {
    console.log(`\n本局有独食者，但没人知道是谁。`);
    declare(state, 'none');
  }
  if (state.baiPai && state.soloSeat !== null) {
    const solo = state.seats[state.soloSeat];
    console.log(`\n【摆牌】${solo.name} 的手牌：${solo.hand.map(cardLabel).join(' ')}`);
  }
}

// ── 主循环 ──────────────────────────────────────────────
let steps = 0;
while (state.phase === 'playing') {
  if (++steps > 500) {
    console.log('对局异常，已中止');
    break;
  }
  const seat = state.currentSeat;

  if (seat !== mySeat || allBot) {
    const action = chooseAction(state, seat);
    if (action.type === 'play') {
      const p = play(state, seat, action.cards);
      console.log(`  ${state.seats[seat].name}: ${action.cards.map(cardLabel).join(' ')}（${patternName(p)}）`);
    } else {
      pass(state, seat);
      console.log(`  ${state.seats[seat].name}: 不出`);
    }
    continue;
  }

  render();
  if (state.trick) {
    const t = state.trick;
    console.log(
      `轮到你了：要压 ${state.seats[t.seat].name} 的 ${t.cards.map(cardLabel).join(' ')}（${patternName(t.pattern)}）`,
    );
  } else {
    console.log('轮到你了：新一轮，你可以出任意牌型。');
  }

  for (;;) {
    const raw = await ask('出牌（序号 / p 不出 / h 提示 / q 退出）> ');
    if (raw === null) quit();

    const t = raw.toLowerCase();
    if (t === 'q' || t === 'quit' || t === '退出') quit();
    if (t === 'h' || t === 'hint' || t === '提示') {
      showHints();
      continue;
    }
    if (t === 'p' || t === 'pass' || t === '不出' || t === '过') {
      if (!canPass(state, seat)) {
        console.log('  报单必须出牌，不能不出。');
        continue;
      }
      pass(state, seat);
      console.log('  你：不出');
      break;
    }

    const nums = t.split(/[\s,，]+/).filter(Boolean).map(Number);
    const hand = state.seats[mySeat].hand;
    if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > hand.length)) {
      console.log(`  请输入 1-${hand.length} 之间的序号，例如 "1 2 3"`);
      continue;
    }
    if (new Set(nums).size !== nums.length) {
      console.log('  序号不能重复');
      continue;
    }

    const cards: Card[] = nums.map((n) => hand[n - 1]);
    const v = validatePlay(state, seat, cards);
    if (!v.ok) {
      console.log(`  ✗ ${v.reason}`);
      continue;
    }
    play(state, seat, cards);
    console.log(`  你：${cards.map(cardLabel).join(' ')}（${patternName(v.pattern!)}）`);
    break;
  }
}

// ── 结算 ────────────────────────────────────────────────
const result = settle(state);
console.log(`\n${RULE}`);
console.log(`结算：${result.reason}`);
for (const s of state.seats) {
  const d = result.deltas[s.id];
  const sign = d > 0 ? `+${d}` : `${d}`;
  console.log(`  ${s.name.padEnd(4)} ${(PLACE_NAMES[s.place ?? 4] ?? '').padEnd(4)} ${sign}`);
}
console.log(`  合计 ${result.deltas.reduce((a, b) => a + b, 0)}（应为 0）`);

rl.close();
