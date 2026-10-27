import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { executeExtensionCommand } from '../src/lib/extension-command';

const extension = { id: 'dfbdlidakbmfedfidhpbnelkkjoombhj', name: 'Bookmark Pro', path: 'D:\\扩展\\Bookmark Pro' };
async function execute(args: string[], reload: () => Promise<object> = async () => ({ result: { value: true } })) {
  const calls: unknown[] = [];
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: any) => {
      calls.push([method, params]);
      if (method === 'Extensions.getExtensions') return { extensions: [extension] };
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.createTarget') return { targetId: 'hidden-target' };
      if (method === 'Target.attachToTarget') return { sessionId: 'manager-session' };
      if (method === 'Target.sendMessageToTarget') {
        const request = JSON.parse(params.message);
        let result: object = {};
        if (request.method === 'Page.navigate') {
          result = { loaderId: 'manager-loader' };
          // load 事件可以早于导航响应，必须匹配本次导航的 loader。
          for (const loaderId of ['about-blank-loader', 'manager-loader']) {
            cdp.emit('Target.receivedMessageFromTarget', {
              sessionId: 'manager-session',
              message: JSON.stringify({ method: 'Page.lifecycleEvent', params: { name: 'load', loaderId } }),
            });
          }
        }
        if (request.method === 'Runtime.evaluate') {
          if (!request.params.expression.startsWith('chrome.developerPrivate.')) throw new Error('Chrome 管理页没有 tabs/windows API');
          result = request.params.expression.includes('chrome.developerPrivate.reload(')
            ? await reload()
            : { result: { value: { views: [] } } };
        }
        cdp.emit('Target.receivedMessageFromTarget', {
          sessionId: 'manager-session', message: JSON.stringify({ id: request.id, result }),
        });
      }
      return {};
    },
    detach: async () => { calls.push('detach'); },
  });
  let result: any;
  try { result = await executeExtensionCommand({ newBrowserCDPSession: async () => cdp } as any, args); }
  catch (error) { result = { error: (error as Error).message }; }
  return { result, calls, cdp };
}
test('查询返回扩展并释放 CDP session', async () => {
  const { result, calls } = await execute(['list_extensions']);
  expect(result.extensions).toEqual([extension]);
  expect(calls).toEqual([['Extensions.getExtensions', undefined], 'detach']);
});
test('重载通过隐藏管理页保留安装方式，等待完成并清理页面与连接', async () => {
  const { result, calls, cdp } = await execute(['reload_extension', extension.id]);
  expect(result).toEqual({ reloaded: true });
  expect(calls[1]).toEqual(['Target.createTarget', { url: 'about:blank', hidden: true }]);
  const commands = calls.filter(Array.isArray).filter(call => call[0] === 'Target.sendMessageToTarget')
    .map(call => JSON.parse(call[1].message));
  expect(commands.map(command => command.method)).toEqual([
    'Page.enable', 'Page.setLifecycleEventsEnabled', 'Page.navigate', 'Runtime.evaluate', 'Runtime.evaluate',
  ]);
  expect(commands.at(-1).params.expression).toContain(`chrome.developerPrivate.reload("${extension.id}"`);
  expect(commands.at(-1).params.awaitPromise).toBe(true);
  expect(calls.slice(-2)).toEqual([['Target.closeTarget', { targetId: 'hidden-target' }], 'detach']);
  expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
});
test('重载失败或 API 返回错误时释放隐藏页面和连接', async () => {
  expect((await execute(['reload_extension', extension.id], async () => { throw new Error('权限错误'); })).result).toEqual({ error: '权限错误' });
  const { result, calls, cdp } = await execute(['reload_extension', extension.id], async () => ({
    exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: manifest 无效' } },
  }));
  expect(result.error).toContain('manifest 无效');
  expect(calls.slice(-2)).toEqual([['Target.closeTarget', { targetId: 'hidden-target' }], 'detach']);
  expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
});
test('管理 API 未确认成功时不会误报重载完成', async () => {
  const { result } = await execute(['reload_extension', extension.id], async () => ({ result: { value: false } }));
  expect(result.error).toContain('未确认重载成功');
});
test('不存在的 ID 保留缓存失效识别信息，参数按数据处理', async () => {
  const id = '"; throw new Error("注入"); //';
  const { result, calls } = await execute(['reload_extension', id]);
  expect(result.error).toBe(`Extension with ID ${id} not found.`);
  expect(calls).toEqual([['Extensions.getExtensions', undefined], 'detach']);
});
