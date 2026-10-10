import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncPlaywright } from '../scripts/sync-playwright';
test('从上游生成授权脚本，上游缺失或未配置时即使已有产物也报错', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reload-sync-'));
  try {
    await mkdir(path.join(root, 'skills/shared'), { recursive: true });
    const source = path.join(root, 'skills/shared/chromium-connect.ps1');
    await writeFile(source, '授权脚本');
    await syncPlaywright('skills', root);
    const target = path.join(root, 'scripts/playwright/chromium-connect.ps1');
    expect(await readFile(target, 'utf8')).toBe('授权脚本');
    await rm(source);
    await expect(syncPlaywright(undefined, root)).rejects.toThrow('必须配置 SKILLS_REPO_DIR');
    await expect(syncPlaywright('  ', root)).rejects.toThrow('必须配置 SKILLS_REPO_DIR');
    await expect(syncPlaywright('skills', root)).rejects.toThrow('无法读取 skills 上游脚本');
    expect(await readFile(target, 'utf8')).toBe('授权脚本');
  } finally { await rm(root, { recursive: true, force: true }); }
});
