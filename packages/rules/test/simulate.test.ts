import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/sim.ts';

test('随机对局不变量（1000 局）', () => {
  const stats = simulate(1000, { baseSeed: 20261116 });
  assert.equal(stats.games, 1000);
  // 独食局频率应接近 23.5%（♠3 与 ♠A 同持）
  assert.ok(stats.soloGames > 150 && stats.soloGames < 320, `独食局数量异常: ${stats.soloGames}`);
  console.log(
    `[sim] 局数=${stats.games} 独食局=${stats.soloGames} 独食头游=${stats.soloWins} ` +
      `摆牌=${stats.baiPaiGames} 投降=${stats.surrenders} ` +
      `平均步数=${(stats.steps / stats.games).toFixed(1)} 最大步数=${stats.maxSteps}`,
  );
});
