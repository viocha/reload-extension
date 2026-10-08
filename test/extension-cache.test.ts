import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExtensionCache } from '../src/lib/extension-cache';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reload-cache-test-'));
  roots.push(root);
  return { root, cache: createExtensionCache(root) };
}
const entry = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Bookmark Pro' };

test('缓存跨实例持久化，忽略查询名称大小写与首尾空格，隔离浏览器', async () => {
  const { root, cache } = await fixture();
  await cache.set('edge', 'Bookmark Pro', entry);
  expect(await createExtensionCache(root).get('edge', ' bookmark pro ')).toEqual(entry);
  expect(await cache.get('chrome', 'Bookmark Pro')).toBeUndefined();
  await cache.set('chrome', 'Bookmark Pro', { ...entry, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  expect((await cache.get('edge', 'Bookmark Pro'))?.id).toBe(entry.id);
  expect((await cache.get('chrome', 'Bookmark Pro'))?.id).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('过期和损坏记录按未命中处理，删除映射不影响其他记录', async () => {
  const { root, cache } = await fixture();
  await cache.set('edge', 'Bookmark Pro', entry);
  const file = path.join(root, (await readdir(root))[0]);
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
  expect(await cache.get('edge', 'Bookmark Pro')).toBeUndefined();
  await cache.set('edge', 'Bookmark Pro', entry);
  await writeFile(file, '{损坏');
  expect(await cache.get('edge', 'Bookmark Pro')).toBeUndefined();
  await cache.set('edge', 'Bookmark Pro', entry);
  await cache.set('chrome', 'Bookmark Pro', entry);
  await cache.remove('edge', 'Bookmark Pro');
  expect(await cache.get('edge', 'Bookmark Pro')).toBeUndefined();
  expect(await cache.get('chrome', 'Bookmark Pro')).toEqual(entry);
});

test('清空全部映射可重复执行，并保留无关文件', async () => {
  const { root, cache } = await fixture();
  await cache.clear();
  await cache.set('edge', 'Bookmark Pro', entry);
  await cache.set('chrome', 'Bookmark Pro', entry);
  await writeFile(path.join(root, 'keep.txt'), '保留');
  await cache.clear();
  expect(await readdir(root)).toEqual(['keep.txt']);
  expect(await cache.get('edge', 'Bookmark Pro')).toBeUndefined();
  expect(await cache.get('chrome', 'Bookmark Pro')).toBeUndefined();
  await cache.clear();
  expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('保留');
});
