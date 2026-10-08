import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createCommandSession } from './browser-session.js';

import { createExtensionScript } from './playwright-code.js';

type Browser = 'edge' | 'chrome';
export interface CommandResult { stdout: string; stderr: string }
export type RunBrowser = (args: string[]) => Promise<CommandResult>;

let packageRoot = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(packageRoot, 'package.json'))) {
  const parent = path.dirname(packageRoot);
  if (parent === packageRoot) throw new Error('未找到 reload-extension 包目录');
  packageRoot = parent;
}
const scriptsDir = path.join(packageRoot, 'scripts', 'playwright');

async function startWorker(browser: Browser): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform !== 'win32') throw new Error('reload-extension 当前仅支持 Windows');
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const child = spawn(shell, [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(scriptsDir, 'browser-session.ps1'),
      '-Browser', browser === 'edge' ? 'msedge' : 'chrome',
    ], { cwd: packageRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return child;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('未找到 PowerShell: pwsh.exe / powershell.exe 不可用');
}

/** 单次操作共用一个 PowerShell 进程与浏览器连接，结束后关闭会话。 */
export async function withBrowserSession<T>(
  browser: Browser,
  operation: (run: RunBrowser) => Promise<T>,
): Promise<T> {
  const session = createCommandSession(await startWorker(browser));
  try {
    return await operation(args => session.run(['run', createExtensionScript(args)]));
  } finally {
    await session.close();
  }
}
