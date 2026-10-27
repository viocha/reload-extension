import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { captureSidePanels, restoreSidePanels } from '../src/lib/extension-side-panels';
import { evaluateTarget } from '../src/lib/target-evaluate';

const url = 'chrome-extension://test/panel.html';
function fixture(targets: any[] = [], result: any = true) {
  const calls: any[] = [];
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, params: any = {}) => {
      calls.push([method, params]);
      if (method === 'Target.getTargets') return { targetInfos: targets };
      if (method === 'Target.createTarget') return { targetId: 'helper' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-' + params.targetId };
      if (method === 'Target.sendMessageToTarget') {
        const request = JSON.parse(params.message);
        const emit = (message: object) => cdp.emit('Target.receivedMessageFromTarget', { sessionId: params.sessionId, message: JSON.stringify(message) });
        if (request.method === 'Runtime.enable') {
          emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin: '://', auxData: { isDefault: true } } } });
          emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 2, origin: 'chrome-extension://test', auxData: { isDefault: false } } } });
          emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 3, origin: 'chrome-extension://test', auxData: { isDefault: true } } } });
          emit({ id: request.id, result: {} });
        } else {
          emit({ id: request.id, result: { result: { value: result } } });
        }
      }
      return {};
    },
  });
  const expressions = () => calls.filter(([method]) => method === 'Target.sendMessageToTarget').map(([, params]) => JSON.parse(params.message)).filter(request => request.method === 'Runtime.evaluate');
  return { cdp: cdp as any, calls, expressions };
}

test('等待扩展主执行上下文后执行，避开 about:blank 和隔离世界', async () => {
  const { cdp, expressions } = fixture([], 'ready');
  expect(await evaluateTarget(cdp, 'page', 'chrome.tabs.query({})', false, 'chrome-extension://test')).toBe('ready');
  expect(expressions()).toHaveLength(1);
  expect(expressions()[0].params.contextId).toBe(3);
  expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
});

test('侧边栏快照只检查匹配的页面，未显示的视图不恢复', async () => {
  const { cdp, calls, expressions } = fixture([
    { targetId: 'panel', type: 'page', url },
    { targetId: 'worker', type: 'service_worker', url },
    { targetId: 'other', type: 'page', url: 'https://example.com/' },
  ], null);
  expect(await captureSidePanels(cdp, [url])).toEqual([]);
  expect(calls.filter(([method]) => method === 'Target.attachToTarget')).toEqual([
    ['Target.attachToTarget', { targetId: 'panel', flatten: false }],
  ]);
  expect(expressions()[0].params.expression).toContain("document.visibilityState !== 'visible'");
});

test('没有普通扩展页时使用临时扩展文档恢复侧边栏，不从 worker 伪造用户手势', async () => {
  const { cdp, calls, expressions } = fixture([{ targetId: 'worker', type: 'service_worker', url: 'chrome-extension://test/background.js' }]);
  const errors = await restoreSidePanels(cdp, 'test', [{ url, path: 'panel.html', windowId: 1, tabId: 2 }], { 1: 10 }, { 2: 20 });
  expect(errors).toEqual([]);
  expect(calls).toContainEqual(['Target.createTarget', { url, hidden: true }]);
  expect(calls.at(-1)).toEqual(['Target.closeTarget', { targetId: 'helper' }]);
  expect(expressions()[0].params.userGesture).toBe(true);
  expect(expressions()[0].params.expression).toContain('"tabId":20');
});

test('复用恢复后的扩展文档，并按原窗口重新打开全局侧边栏', async () => {
  const { cdp, calls, expressions } = fixture([{ targetId: 'options', type: 'page', url: 'chrome-extension://test/options.html' }]);
  expect(await restoreSidePanels(cdp, 'test', [{ url, path: 'panel.html', windowId: 1 }], { 1: 10 }, {})).toEqual([]);
  expect(calls.some(([method]) => method === 'Target.createTarget')).toBe(false);
  expect(expressions()[0].params.expression).toContain('"windowId":10');
});
