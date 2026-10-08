import { beforeEach, expect, mock, test } from 'bun:test';

const runDevTools = mock(async (_browser: string, _args: string[], _options?: { connected?: boolean }) => ({
  stdout: 'id=mkfepgaeakcbnbbpdkmifpaebajnkioj "Newtab Pro" v1.17.17 Enabled\n',
  stderr: '',
}));
const withDevToolsSession = mock(async (browser: string, operation: (run: (args: string[]) => Promise<{ stdout: string; stderr: string }>) => Promise<unknown>) => {
  try { return await operation((args) => runDevTools(browser, args)); }
  finally { await runDevTools(browser, ['stop']); }
});
mock.module('../src/lib/devtools.js', () => ({ withDevToolsSession }));
const cache = new Map<string, { id: string; name: string }>();
mock.module('../src/lib/extension-cache.js', () => ({ extensionCache: {
  get: async (browser: string, name: string) => cache.get(browser + ':' + name),
  set: async (browser: string, name: string, value: { id: string; name: string }) => { cache.set(browser + ':' + name, { id: value.id, name: value.name }); },
  remove: async (browser: string, name: string) => { cache.delete(browser + ':' + name); },
  clear: async () => { cache.clear(); },
} }));
const { clearExtensionCache, listExtensions, reloadExtension } = await import('../src/index.js');

beforeEach(() => {
  cache.clear();
  runDevTools.mockReset();
  runDevTools.mockImplementation(async () => ({
    stdout: 'id=mkfepgaeakcbnbbpdkmifpaebajnkioj "Newtab Pro" v1.17.17 Enabled\n',
    stderr: '',
  }));
});

test('名称首次成功后缓存 ID，后续跳过列表查询', async () => {
  await reloadExtension({ name: 'Newtab Pro' });
  runDevTools.mockClear();
  await reloadExtension({ name: 'Newtab Pro' });
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['reload_extension', 'mkfepgaeakcbnbbpdkmifpaebajnkioj']],
    ['edge', ['stop']],
  ]);
});

test('跳过缓存时重新查询并更新映射', async () => {
  cache.set('edge:Newtab Pro', { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Newtab Pro' });
  await reloadExtension({ name: 'Newtab Pro', cache: false });
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['list_extensions']],
    ['edge', ['reload_extension', 'mkfepgaeakcbnbbpdkmifpaebajnkioj']],
    ['edge', ['stop']],
  ]);
  expect(cache.get('edge:Newtab Pro')?.id).toBe('mkfepgaeakcbnbbpdkmifpaebajnkioj');
});

test('清空缓存不启动浏览器会话', async () => {
  cache.set('edge:Newtab Pro', { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Newtab Pro' });
  cache.set('chrome:Newtab Pro', { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Newtab Pro' });
  await clearExtensionCache();
  expect(cache.size).toBe(0);
  expect(runDevTools).not.toHaveBeenCalled();
});

test('缓存 ID 不存在时重新查找并更新缓存', async () => {
  const staleId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  cache.set('edge:Newtab Pro', { id: staleId, name: 'Newtab Pro' });
  runDevTools.mockRejectedValueOnce(new Error(`Extension with ID ${staleId} not found.`));
  await reloadExtension({ name: 'Newtab Pro' });
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['reload_extension', staleId]],
    ['edge', ['list_extensions']],
    ['edge', ['reload_extension', 'mkfepgaeakcbnbbpdkmifpaebajnkioj']],
    ['edge', ['stop']],
  ]);
  expect(cache.get('edge:Newtab Pro')?.id).toBe('mkfepgaeakcbnbbpdkmifpaebajnkioj');
});

test('缓存命中后的连接错误不触发查询或删除缓存', async () => {
  const entry = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Newtab Pro' };
  cache.set('edge:Newtab Pro', entry);
  runDevTools.mockRejectedValueOnce(new Error('连接失败'));
  await expect(reloadExtension({ name: 'Newtab Pro' })).rejects.toThrow('连接失败');
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['reload_extension', entry.id]],
    ['edge', ['stop']],
  ]);
  expect(cache.get('edge:Newtab Pro')).toEqual(entry);
});

test('按名称重载共用连接，完成后关闭 session', async () => {
  await reloadExtension({ name: 'Newtab Pro' });
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['list_extensions']],
    ['edge', ['reload_extension', 'mkfepgaeakcbnbbpdkmifpaebajnkioj']],
    ['edge', ['stop']],
  ]);
});

test('按 ID 重载完成后关闭对应浏览器的 session', async () => {
  await reloadExtension({ id: 'extension-id', browser: 'chrome' });
  expect(runDevTools.mock.calls).toEqual([
    ['chrome', ['reload_extension', 'extension-id']],
    ['chrome', ['stop']],
  ]);
});

test('单独查询扩展列表后关闭 session', async () => {
  expect(await listExtensions()).toHaveLength(1);
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['list_extensions']],
    ['edge', ['stop']],
  ]);
});

test('扩展名称查找失败时关闭 session', async () => {
  await expect(reloadExtension({ name: '不存在的扩展' })).rejects.toThrow();
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['list_extensions']],
    ['edge', ['stop']],
  ]);
});

test('DevTools 命令失败时关闭 session 并报告错误', async () => {
  runDevTools.mockRejectedValueOnce(new Error('连接失败'));
  await expect(reloadExtension({ id: 'extension-id' })).rejects.toThrow('连接失败');
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['reload_extension', 'extension-id']],
    ['edge', ['stop']],
  ]);
});

test('查询失败时跳过重载并关闭 session', async () => {
  runDevTools.mockRejectedValueOnce(new Error('查询失败'));
  await expect(reloadExtension({ name: 'Newtab Pro' })).rejects.toThrow('查询失败');
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['list_extensions']],
    ['edge', ['stop']],
  ]);
});

test('复用连接重载失败时关闭 session 并报告错误', async () => {
  runDevTools.mockResolvedValueOnce({
    stdout: 'id=mkfepgaeakcbnbbpdkmifpaebajnkioj "Newtab Pro" v1.17.17 Enabled\n',
    stderr: '',
  });
  runDevTools.mockRejectedValueOnce(new Error('会话失效'));
  await expect(reloadExtension({ name: 'Newtab Pro' })).rejects.toThrow('会话失效');
  expect(runDevTools.mock.calls).toEqual([
    ['edge', ['list_extensions']],
    ['edge', ['reload_extension', 'mkfepgaeakcbnbbpdkmifpaebajnkioj']],
    ['edge', ['stop']],
  ]);
});
