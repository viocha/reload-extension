import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandResult } from './devtools.js';

const PREFIX = 'RELOAD_EXTENSION_RESULT=';

export function createCommandSession(child: ChildProcessWithoutNullStreams) {
  let pending: { resolve: (result: CommandResult) => void; reject: (error: Error) => void } | undefined;
  let buffer = '', stderr = '';
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    pending?.reject(error);
    pending = undefined;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', fail);
  child.on('error', fail);
  const exited = new Promise<void>(resolve => {
    child.once('exit', code => {
      fail(new Error(`PowerShell 会话已退出，退出码 ${code}${stderr ? `\n${stderr.trim()}` : ''}`));
      child.stdout.destroy();
      child.stderr.destroy();
      resolve();
    });
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trimEnd();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith(PREFIX)) continue;
      try {
        const result = JSON.parse(line.slice(PREFIX.length)) as CommandResult & { error?: string };
        if (result.error) pending?.reject(new Error(result.error));
        else pending?.resolve(result);
        pending = undefined;
      } catch (error) { fail(error as Error); }
    }
  });
  const run = (args: string[]): Promise<CommandResult> => {
    if (failure) return Promise.reject(failure);
    if (pending) return Promise.reject(new Error('同一 DevTools 会话不能并发执行命令'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      child.stdin.write(JSON.stringify(args) + '\n');
    });
  };
  const close = async () => {
    try { await run(['stop']); } finally {
      child.stdin.end();
      await exited;
    }
  };
  return { run, close };
}
