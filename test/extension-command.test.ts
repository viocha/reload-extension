import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { executeExtensionCommand } from '../src/lib/extension-command';

const extension = { id: 'dfbdlidakbmfedfidhpbnelkkjoombhj', name: 'Bookmark Pro', path: 'D:\\扩展\\Bookmark Pro' };
async function execute(args: string[], reload: () => Promise<object> = async () => ({ result: { value: true } }), newtab?: { api: any; viewUrl?: string }, manager?: { state: string; api: any }) {
  const calls: unknown[] = [];
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: any) => {
      calls.push([method, params]);
      if (method === 'Extensions.getExtensions') return { extensions: [extension] };
      if (method === 'Target.getTargets') return { targetInfos: newtab?.viewUrl ? [{ type: 'page', targetId: 'helper', url: newtab.viewUrl }] : [] };
      if (method === 'Target.createTarget') {
        return { targetId: params.url === 'about:blank' ? 'hidden-target' : params.hidden ? 'helper' : 'created-target' };
      }
      if (method === 'Target.attachToTarget') return { sessionId: params.targetId === 'hidden-target' ? 'manager-session' : 'helper-session' };
      if (method === 'Target.sendMessageToTarget') {
        const request = JSON.parse(params.message);
        if (params.sessionId === 'helper-session') {
          const emit = (message: object) => cdp.emit('Target.receivedMessageFromTarget', { sessionId: params.sessionId, message: JSON.stringify(message) });
          if (request.method === 'Runtime.enable') {
            emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin: `chrome-extension://${extension.id}`, auxData: { isDefault: true } } } });
            emit({ id: request.id, result: {} });
          } else {
            const value = await new Function('chrome', `return ${request.params.expression}`)(newtab!.api);
            emit({ id: request.id, result: { result: { value } } });
          }
          return {};
        }
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
          if (!request.params.expression.startsWith('chrome.developerPrivate.') && !request.params.expression.includes('async function reloadManagedExtension(')) throw new Error('Chrome 管理页没有 tabs/windows API');
          result = request.params.expression.includes('async function reloadManagedExtension(')
            ? manager ? { result: { value: await new Function('chrome', `return ${request.params.expression}`)({ developerPrivate: manager.api }) } } : await reload()
            : { result: { value: { state: manager?.state ?? 'ENABLED', views: newtab ? [{ type: 'TAB_CONTENTS', url: newtab.viewUrl ?? 'edge://newtab/' }] : [] } } };
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

test('只有新标签页且 target 仅报告原生入口时，通过隐藏文档恢复真正的新标签页', async () => {
  const origin = `chrome-extension://${extension.id}/`;
  const tab = { id: 17, windowId: 1, index: 3, url: 'edge://newtab/', active: true, pinned: false, groupId: -1 };
  const replacement = { ...tab, id: 99, index: 4, active: false };
  const updates: any[] = [];
  const removed: number[][] = [];
  let reloaded = false;
  const creations: any[] = [];
  const api = {
    extension: { getViews: () => [{ location: { href: origin + 'newtab.html' }, chrome: { tabs: { getCurrent: async () => tab } } }] },
    tabs: {
      query: async () => creations.length ? [replacement, tab] : [tab],
      create: async (properties: any) => {
        if (!reloaded) throw new Error('替代页必须在扩展重载后创建');
        creations.push(properties);
        tab.active = false;
        tab.index = 4;
        Object.assign(replacement, properties);
        return replacement;
      },
      getCurrent: async () => replacement,
      update: async (id: number, properties: any) => { updates.push([id, properties]); Object.assign(id === tab.id ? tab : replacement, properties); },
      move: async () => {},
      remove: async (ids: number[]) => { removed.push(ids); },
    },
    windows: { getAll: async () => [{ id: 1, focused: false }], getLastFocused: async () => ({ id: 1 }) },
  };
  const { result, calls } = await execute(['reload_extension', extension.id], async () => {
    reloaded = true;
    return { result: { value: true } };
  }, { api });
  expect(result).toEqual({ reloaded: true });
  expect(updates).toEqual([]);
  expect(removed).toEqual([[17]]);
  expect(creations).toEqual([{ url: 'edge://newtab/', windowId: 1, index: 3, active: true, pinned: false }]);
  expect(calls.filter(Array.isArray).filter(call => call[0] === 'Target.createTarget' && !call[1].hidden)).toHaveLength(0);
  expect(calls.filter(Array.isArray).filter(call => call[0] === 'Target.closeTarget' && call[1].targetId === 'helper')).toHaveLength(2);
});
test('常规扩展页在重载后优先补回当前页，后台存活页复用', async () => {
  const origin = `chrome-extension://${extension.id}/`;
  const foreground = { id: 1, windowId: 1, index: 0, url: origin + 'options.html', active: true, pinned: false, groupId: -1 };
  const background = { ...foreground, id: 2, index: 1, url: origin + 'other.html', active: false };
  const creations: any[] = [];
  let live = [foreground, background];
  const api = {
    extension: { getViews: () => [] },
    tabs: {
      query: async () => live,
      create: async (properties: any) => {
        creations.push(properties);
        const tab = { ...foreground, ...properties, id: 99 };
        live = [tab, ...live];
        return tab;
      },
      update: async () => { throw new Error('当前页已在创建时激活'); },
      move: async () => {},
    }, windows: { getAll: async () => [{ id: 1, focused: true }] },
  };
  const { result, calls } = await execute(['reload_extension', extension.id], async () => {
    live = [background];
    return { result: { value: true } };
  }, { api, viewUrl: background.url });
  expect(result).toEqual({ reloaded: true });
  expect(creations).toEqual([{ url: foreground.url, windowId: 1, index: 0, active: true, pinned: false }]);
  expect(live.map(tab => tab.id)).toEqual([99, 2]);
  expect(calls.filter(Array.isArray).filter(call => call[0] === 'Target.createTarget' && !call[1].hidden)).toEqual([]);
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
  expect(commands.at(-1).params.expression).toContain(`)(chrome.developerPrivate, "${extension.id}", false)`);
  expect(commands.at(-1).params.awaitPromise).toBe(true);
  expect(calls.slice(-2)).toEqual([['Target.closeTarget', { targetId: 'hidden-target' }], 'detach']);
  expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
});

test('禁用扩展重载通过安装事件完成，关闭隐藏管理页并断开连接', async () => {
  const listeners = new Set<(event: any) => void>();
  const { result, calls, cdp } = await execute(['reload_extension', extension.id], undefined, undefined, {
    state: 'DISABLED',
    api: {
      onItemStateChanged: {
        addListener: (listener: (event: any) => void) => { listeners.add(listener); },
        removeListener: (listener: (event: any) => void) => { listeners.delete(listener); },
      },
      reload: () => {
        for (const listener of listeners) listener({ item_id: extension.id, event_type: 'INSTALLED' });
        return new Promise(() => {});
      },
    },
  });
  expect(result).toEqual({ reloaded: true });
  expect(listeners.size).toBe(0);
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
