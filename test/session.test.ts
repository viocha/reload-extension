import { beforeEach, expect, mock, test } from 'bun:test';

const runDevTools = mock(async (_browser: string, _args: string[]) => ({
  stdout: 'id=mkfepgaeakcbnbbpdkmifpaebajnkioj "Newtab Pro" v1.17.17 Enabled\n',
  stderr: '',
}));
mock.module('../src/lib/devtools.js', () => ({ runDevTools }));
const { listExtensions, reloadExtension } = await import('../src/index.js');

beforeEach(() => {
  runDevTools.mockReset();
  runDevTools.mockImplementation(async () => ({
    stdout: 'id=mkfepgaeakcbnbbpdkmifpaebajnkioj "Newtab Pro" v1.17.17 Enabled\n',
    stderr: '',
  }));
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
