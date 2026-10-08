import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test.skipIf(process.platform !== 'win32')('PowerShell 会话只连接一次，并识别退出码为零的工具错误', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reload-session-test-'));
  const worker = await readFile(new URL('../scripts/playwright/browser-session.ps1', import.meta.url), 'utf8');
  await writeFile(path.join(root, 'browser-session.ps1'), worker);
  await writeFile(path.join(root, 'package-runtime.ps1'), `
function Invoke-PlaywrightCli {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    if ($Arguments -contains 'detach') { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'stopped'), 'yes'); return }
    $code = $Arguments[-1]
    if ($code -eq 'bad') { '{"error":"找不到扩展"}' }
    elseif ($code -eq 'list') { '{"extensions":[]}' }
    else { '{"reloaded":true}' }
}
`);
  await writeFile(path.join(root, 'connect-playwright-session.ps1'), `
param([string]$Browser, [string]$Session, [int]$TimeoutSeconds, [string[]]$CommandArgs)
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'connections'), '1')
Invoke-PlaywrightCli @CommandArgs
`);
  try {
    // 发布产物使用 Node，直接验证它与 PowerShell 的双向通信。
    const child = spawn('node.exe', ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { strict as assert } from 'node:assert';
      import { createCommandSession } from ${JSON.stringify(new URL('../src/lib/browser-session.ts', import.meta.url).href)};
      const session = createCommandSession(spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', ${JSON.stringify(path.join(root, 'browser-session.ps1'))}, '-Browser', 'msedge'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
      try {
        assert.equal((await session.run(['run', 'list'])).stdout, '{"extensions":[]}');
        assert.equal((await session.run(['run', 'good'])).stdout, '{"reloaded":true}');
        await assert.rejects(session.run(['run', 'bad']), /找不到扩展/);
      } finally { await session.close(); }
    `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
    });
    expect(await readFile(path.join(root, 'connections'), 'utf8')).toBe('1');
    expect(await readFile(path.join(root, 'stopped'), 'utf8')).toBe('yes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
