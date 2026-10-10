import { chromium } from 'playwright-core';
import { createInterface } from 'node:readline';
import { executeExtensionCommand } from './lib/extension-command.js';

let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    let stop = false;
    let result: object;
    try {
      const args = JSON.parse(line) as string[];
      stop = args[0] === 'stop';
      if (stop) {
        await browser?.close(); // CDP 连接的 close 仅断开连接，保留用户浏览器。
        browser = undefined;
        result = { stdout: '', stderr: '' };
      } else {
        browser ??= await chromium.connectOverCDP(process.argv[2]!, { timeout: 10000, noDefaults: true });
        const payload = await executeExtensionCommand(browser, args);
        result = { stdout: JSON.stringify(payload), stderr: '' };
      }
    } catch (error) {
      result = { error: (error as Error).message };
    }
    process.stdout.write('RELOAD_EXTENSION_RESULT=' + JSON.stringify(result) + '\n');
    if (stop) break;
  }
} finally {
  lines.close();
  await browser?.close();
}
