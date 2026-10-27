import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { captureExtensionSnapshot } from '../src/lib/extension-snapshot';

const origin = 'chrome-extension://test';
const url = origin + '/options.html';
const window = { id: 1, type: 'normal', incognito: false, focused: true, state: 'normal', left: 0, top: 0, width: 1000, height: 800 };
const tab = { id: 2, windowId: 1, index: 1, url, active: false, pinned: true, groupId: -1 };

function fixture(targets: any[], query: () => Promise<object[]> = async () => [tab]) {
  const calls: any[] = [];
  // 扩展自身提供 tabs/windows，不提供管理页的 developerPrivate。
  const chrome = { tabs: { query }, windows: { getAll: async () => [window] } };
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, params: any = {}) => {
      calls.push([method, params]);
      if (method === 'Target.getTargets') return { targetInfos: targets };
      if (method === 'Target.createTarget') return { targetId: 'helper' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Target.sendMessageToTarget') {
        const request = JSON.parse(params.message);
        const emit = (message: object) => cdp.emit('Target.receivedMessageFromTarget', { sessionId: 'session', message: JSON.stringify(message) });
        if (request.method === 'Runtime.enable') {
          emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin, auxData: { isDefault: true } } } });
          emit({ id: request.id, result: {} });
        } else {
          try {
            const value = await new Function('chrome', `return ${request.params.expression}`)(chrome);
            emit({ id: request.id, result: { result: { value } } });
          } catch (error) {
            emit({ id: request.id, result: { exceptionDetails: { text: (error as Error).message } } });
          }
        }
      }
      return {};
    },
  });
  return { cdp: cdp as any, calls };
}

test('标签快照在扩展自身上下文执行，不依赖 Chrome 管理页的 tabs/windows', async () => {
  const { cdp, calls } = fixture([
    { targetId: 'manager', type: 'page', url: 'chrome://extensions/' },
    { targetId: 'options', type: 'page', url },
  ]);
  const snapshot = await captureExtensionSnapshot(cdp, 'test', [origin + '/panel.html']);
  expect(snapshot).toEqual({ tabs: [tab], windows: [window], sidePanelUrls: [origin + '/panel.html'] });
  expect(calls.filter(([method]) => method === 'Target.attachToTarget')).toEqual([
    ['Target.attachToTarget', { targetId: 'options', flatten: false }],
  ]);
});

test('没有打开扩展界面时无需创建辅助页面，直接重载', async () => {
  const { cdp, calls } = fixture([{ targetId: 'worker', type: 'service_worker', url: origin + '/background.js' }]);
  expect(await captureExtensionSnapshot(cdp, 'test')).toEqual({ tabs: [], windows: [], sidePanelUrls: [] });
  expect(calls).toEqual([['Target.getTargets', {}]]);
});

test('重载后扩展页全部关闭时，通过隐藏扩展文档读取窗口信息并清理', async () => {
  const { cdp, calls } = fixture([], async () => []);
  expect(await captureExtensionSnapshot(cdp, 'test', [], url)).toEqual({ tabs: [], windows: [window], sidePanelUrls: [] });
  expect(calls).toContainEqual(['Target.createTarget', { url, hidden: true }]);
  expect(calls.at(-1)).toEqual(['Target.closeTarget', { targetId: 'helper' }]);
});

test('快照读取失败时仍关闭隐藏扩展文档，保留实际错误', async () => {
  const { cdp, calls } = fixture([], async () => { throw new Error('读取失败'); });
  await expect(captureExtensionSnapshot(cdp, 'test', [], url)).rejects.toThrow('读取失败');
  expect(calls.at(-1)).toEqual(['Target.closeTarget', { targetId: 'helper' }]);
  expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
});
