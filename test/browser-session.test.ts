import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createCommandSession } from '../src/lib/browser-session';

function createFixture() {
  return createCommandSession(spawn(process.execPath, ['-e', `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const args = JSON.parse(line);
      if (args[0] === 'crash') { console.error('测试进程异常退出'); process.exit(2); }
      const result = args[0] === 'fail' ? { error: '命令失败' } : { stdout: args.join(' ') + ' 中文', stderr: '' };
      const response = 'RELOAD_EXTENSION_RESULT=' + JSON.stringify(result) + '\\n';
      process.stdout.write('普通日志\\n' + response.slice(0, 12));
      process.stdout.write(response.slice(12), () => { if (args[0] === 'stop') process.exit(0); });
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] }));
}

test('单个进程处理多条命令、中文和分段响应，关闭后等待退出', async () => {
  const session = createFixture();
  expect((await session.run(['list_extensions'])).stdout).toBe('list_extensions 中文');
  expect((await session.run(['reload_extension', 'id'])).stdout).toBe('reload_extension id 中文');
  await session.close();
});
test('命令错误保留清理通道', async () => {
  const session = createFixture();
  await expect(session.run(['fail'])).rejects.toThrow('命令失败');
  await session.close();
});

test('进程异常退出时请求和清理均明确失败', async () => {
  const session = createFixture();
  await expect(session.run(['crash'])).rejects.toThrow('退出码 2');
  await expect(session.close()).rejects.toThrow('退出码 2');
});
