import { expect, test } from 'bun:test';
import { createExtensionScript } from '../src/lib/playwright-code';

const extension = { id: 'dfbdlidakbmfedfidhpbnelkkjoombhj', name: 'Bookmark Pro', path: 'D:\\扩展\\Bookmark Pro' };
async function execute(args: string[], load: () => Promise<object> = async () => ({ id: extension.id })) {
  const calls: unknown[] = [];
  const cdp = {
    send: async (method: string, params?: object) => {
      calls.push([method, params]);
      if (method === 'Extensions.getExtensions') return { extensions: [extension] };
      return load();
    },
    detach: async () => { calls.push('detach'); },
  };
  const run = new Function('return (' + createExtensionScript(args) + ')')();
  const result = await run({ context: () => ({ browser: () => ({ newBrowserCDPSession: async () => cdp }) }) });
  return { result, calls };
}
test('查询返回扩展并释放 CDP session', async () => {
  const { result, calls } = await execute(['list_extensions']);
  expect(result.extensions).toEqual([extension]);
  expect(calls).toEqual([['Extensions.getExtensions', undefined], 'detach']);
});
test('重载使用扩展真实路径，等待协议完成后释放连接', async () => {
  const { result, calls } = await execute(['reload_extension', extension.id]);
  expect(result).toEqual({ reloaded: true });
  expect(calls).toEqual([['Extensions.getExtensions', undefined], ['Extensions.loadUnpacked', { path: extension.path }], 'detach']);
});
test('重载失败或返回 ID 不符时报告错误并释放连接', async () => {
  expect((await execute(['reload_extension', extension.id], async () => { throw new Error('权限错误'); })).result).toEqual({ error: '权限错误' });
  const { result, calls } = await execute(['reload_extension', extension.id], async () => ({ id: 'other' }));
  expect(result.error).toContain('ID 不匹配');
  expect(calls.at(-1)).toBe('detach');
});
test('不存在的 ID 保留缓存失效识别信息，参数按数据处理', async () => {
  const id = '"; throw new Error("注入"); //';
  const { result, calls } = await execute(['reload_extension', id]);
  expect(result.error).toBe(`Extension with ID ${id} not found.`);
  expect(calls).toEqual([['Extensions.getExtensions', undefined], 'detach']);
});
