import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test.skipIf(process.platform !== 'win32')('浏览器 worker 复用 CDP，清理隐藏管理页，结束时断开连接', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reload-worker-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    const scripts = path.join(root, 'scripts/playwright');
    await mkdir(scripts, { recursive: true });
    await copyFile(new URL('../scripts/playwright/browser-session.ps1', import.meta.url), path.join(scripts, 'browser-session.ps1'));
    const upstream = process.env.SKILLS_REPO_DIR?.trim();
    if (!upstream) throw new Error('必须配置 SKILLS_REPO_DIR 以验证上游共享逻辑');
    const shared = await readFile(path.join(upstream, 'shared/chromium-connect.ps1'), 'utf8');
    await writeFile(path.join(scripts, 'chromium-connect.ps1'), shared + `
function Initialize-ChromiumRemoteDebuggingAuthorization { param($Browser) }
function Invoke-ChromiumRemoteDebuggingAllow { return $false }
function Stop-ChromiumBrowserWindowFlashing {}
function Restore-ChromiumMinimizedWindows {}
function Stop-ChromiumProcessTree { param($Process); $Process.Kill($true) }
`);
    const pkg = path.join(root, 'node_modules/playwright-core');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    await writeFile(path.join(pkg, 'index.js'), `
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
const record = value => appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, value + '\\n');
export const chromium = { connectOverCDP: async (channel, options) => {
  record('connect:' + channel + ':' + options.timeout + ':' + options.noDefaults);
  return new Proxy({
    newBrowserCDPSession: async () => { const cdp = Object.assign(new EventEmitter(), { send: async (method, params) => {
      record(method);
      if (method === 'Extensions.getExtensions') return { extensions: [{ id: 'id', path: 'D:/扩展' }] };
      if (method === 'Target.createTarget') return { targetId: 'manager' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Target.sendMessageToTarget') {
        const command = JSON.parse(params.message);
        let result = {};
        if (command.method === 'Page.navigate') {
          result = { loaderId: 'loader' };
          cdp.emit('Target.receivedMessageFromTarget', { sessionId: 'session', message: JSON.stringify({
            method: 'Page.lifecycleEvent', params: { name: 'load', loaderId: 'loader' },
          }) });
        }
        if (command.method === 'Runtime.evaluate') result = { result: { value: true } };
        cdp.emit('Target.receivedMessageFromTarget', { sessionId: 'session', message: JSON.stringify({ id: command.id, result }) });
      }
      return {};
    }, detach: async () => record('detach') }); return cdp; },
    close: async () => record('disconnect'),
  }, { get(target, key) {
    if (key === 'then') return undefined;
    if (!(key in target)) throw new Error('禁止访问页面 API：' + String(key));
    return target[key];
  } });
} };
`);
    const built = await Bun.build({ entrypoints: [path.resolve('src/browser-worker.ts')], target: 'node', outdir: path.join(root, 'dist'), external: ['playwright-core'] });
    expect(built.success).toBe(true);
    // 发布产物由 Node 执行，验证同一运行时与 PowerShell 的双向通信和退出事件。
    const child = spawn('node.exe', ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      import { createCommandSession } from ${JSON.stringify(new URL('../src/lib/browser-session.ts', import.meta.url).href)};
      const session = createCommandSession(spawn('pwsh.exe', ${JSON.stringify(['-NoLogo', '-NoProfile', '-File', path.join(scripts, 'browser-session.ps1'), '-Browser', 'msedge'])}, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
      try {
        assert.equal(JSON.parse((await session.run(['list_extensions'])).stdout).extensions.length, 1);
        assert.equal(JSON.parse((await session.run(['reload_extension', 'id'])).stdout).reloaded, true);
        await assert.rejects(session.run(['reload_extension', 'missing']), /not found/);
      } finally { await session.close(); }
    `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors || `测试进程退出码 ${code}`)));
    });
    expect((await readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n')).toEqual([
      'connect:msedge:10000:true', 'Extensions.getExtensions', 'detach',
      'Extensions.getExtensions', 'Target.createTarget', 'Target.attachToTarget',
      'Target.sendMessageToTarget', 'Target.sendMessageToTarget', 'Target.sendMessageToTarget', 'Target.sendMessageToTarget',
      'Target.closeTarget', 'detach',
      'Extensions.getExtensions', 'detach', 'disconnect',
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
