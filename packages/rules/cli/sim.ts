/**
 * 压力测试：跑大量随机对局，检查规则引擎不变量。
 *
 *   npm run soak             # 默认 20000 局
 *   npm run soak -- 100000
 */

import { simulate } from '../src/sim.ts';

const arg = Number(process.argv[2]);
const games = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 20_000;

console.log(`开始压测 ${games} 局…`);
const t0 = performance.now();
const stats = simulate(games, { baseSeed: 987654321 });
const ms = performance.now() - t0;

const pct = (a: number) => `${((a / stats.games) * 100).toFixed(2)}%`;

console.log(`完成：${stats.games} 局，${ms.toFixed(0)}ms（${(stats.games / (ms / 1000)).toFixed(0)} 局/秒）`);
console.log(`  独食局      ${stats.soloGames}（${pct(stats.soloGames)}）`);
console.log(`  独食头游    ${stats.soloWins}（占独食局 ${((stats.soloWins / Math.max(1, stats.soloGames)) * 100).toFixed(1)}%）`);
console.log(`  摆牌局      ${stats.baiPaiGames}（${pct(stats.baiPaiGames)}）`);
console.log(`  投降        ${stats.surrenders}（${pct(stats.surrenders)}）`);
console.log(`  平均步数    ${(stats.steps / stats.games).toFixed(1)}，最大 ${stats.maxSteps}`);
console.log(`  零和校验    通过（合计 ${stats.deltas}）`);
