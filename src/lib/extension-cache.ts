import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Browser = 'edge' | 'chrome';
interface CachedExtension { id: string; name: string }
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 名称映射按浏览器隔离，写入失败不影响重载。 */
export function createExtensionCache(root = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'reload-extension', 'cache',
)) {
  const fileFor = (browser: Browser, name: string) => path.join(root,
    createHash('sha256').update(JSON.stringify([browser, name.trim().toLocaleLowerCase()])).digest('hex') + '.json');
  const remove = async (browser: Browser, name: string) => {
    await rm(fileFor(browser, name), { force: true }).catch(() => {});
  };
  const get = async (browser: Browser, name: string): Promise<CachedExtension | undefined> => {
    try {
      const entry = JSON.parse(await readFile(fileFor(browser, name), 'utf8'));
      if (typeof entry.id !== 'string' || !/^[a-p]{32}$/.test(entry.id)
        || typeof entry.name !== 'string' || typeof entry.savedAt !== 'number'
        || entry.savedAt > Date.now() || Date.now() - entry.savedAt >= MAX_AGE_MS) {
        await remove(browser, name);
        return undefined;
      }
      return { id: entry.id, name: entry.name };
    } catch { return undefined; }
  };
  const set = async (browser: Browser, name: string, extension: CachedExtension) => {
    const file = fileFor(browser, name);
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(root, { recursive: true });
      await writeFile(temp, JSON.stringify({ id: extension.id, name: extension.name, savedAt: Date.now() }), 'utf8');
      await rename(temp, file);
    } catch {
      // 缓存是性能优化，目录不可写时保持正常重载能力。
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  };
  const clear = async () => {
    let files: string[];
    try { files = await readdir(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // 只删除本工具生成的缓存文件，保留目录及其他文件。
    await Promise.all(files.filter(file => /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(file))
      .map(file => rm(path.join(root, file), { force: true })));
  };
  return { get, set, remove, clear };
}

export const extensionCache = createExtensionCache();
