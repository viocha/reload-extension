import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type Browser = 'edge' | 'chrome';

interface CommandResult {
  stdout: string;
  stderr: string;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(packageRoot, 'scripts', 'devtools');

export async function runDevTools(
  browser: Browser,
  args: string[],
): Promise<CommandResult> {
  if (process.platform !== 'win32') {
    throw new Error('reload-extension 当前仅支持 Windows');
  }

  const script = path.join(
    scriptsDir,
    browser === 'edge' ? 'chrome-devtools-edge.ps1' : 'chrome-devtools-chrome.ps1',
  );
  const powershellArgs = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    ...args,
  ];

  const shells = ['pwsh.exe', 'powershell.exe'];
  let lastError: NodeJS.ErrnoException | undefined;

  for (const shell of shells) {
    try {
      return await spawnCapture(shell, powershellArgs);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      if (cause.code !== 'ENOENT') throw error;
      lastError = cause;
    }
  }

  throw new Error(
    `未找到 PowerShell: ${lastError?.message ?? 'pwsh.exe / powershell.exe 不可用'}`,
  );
}

function spawnCapture(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.once('error', reject);
    child.once('exit', code => {
      // chrome-devtools-mcp daemon 可能继承启动进程的输出句柄，
      // PowerShell 自身退出即代表当前命令执行完成。
      child.stdout.destroy();
      child.stderr.destroy();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      reject(
        new Error(
          `${command} 执行失败，退出码 ${code}${details ? `\n${details}` : ''}`,
        ),
      );
    });
  });
}
