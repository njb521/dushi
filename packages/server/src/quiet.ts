/**
 * 只压掉一条噪音：`node:sqlite` 的 ExperimentalWarning。
 *
 * 这条警告每次启动都会刷两行，对"打开就能玩"的体验是纯噪音；SQLite 在 22.x 上行为稳定，
 * 本项目也只用到最基础的表读写。其余警告照旧原样输出（保留默认打印器）。
 *
 * 必须在 import db.ts / 任何 node:sqlite 之前 import 本模块。
 */

const saved = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w: Error) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  for (const listener of saved) (listener as (w: Error) => void).call(process, w);
});
