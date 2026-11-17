/**
 * 房主本地重置密码（没有邮箱找回，这是唯一出口 —— 设计文档 §6.6）。
 *
 *   npm run reset-password -- <用户名> <新密码>
 *
 * 你也可以只给用户名，脚本会交互提示输入新密码（不回显）。重置后该账号的旧登录态全部失效。
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { findUserByName, updatePassword } from '../src/db.ts';
import { hashPassword } from '../src/auth/password.ts';

async function main(): Promise<void> {
  const [username, maybePassword] = process.argv.slice(2);
  if (!username) {
    console.error('用法：npm run reset-password -- <用户名> [新密码]');
    process.exitCode = 1;
    return;
  }

  const user = findUserByName(username.trim());
  if (!user) {
    console.error(`没有这个用户：${username}`);
    process.exitCode = 1;
    return;
  }

  let password = maybePassword ?? '';
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    password = (await rl.question(`给「${user.username}」设置新密码（至少 6 位）：`)).trim();
    rl.close();
  }
  if (password.length < 6) {
    console.error('密码至少 6 位');
    process.exitCode = 1;
    return;
  }

  updatePassword(user.id, await hashPassword(password));
  console.log(`✅ 已重置「${user.username}」的密码，旧登录态已失效。`);
}

await main();
