import { expect, test } from 'bun:test';
import { captureExtensionPages, restoreExtensionPages, type ExtensionPages, type ExtensionTab } from '../src/lib/extension-pages';
import { createMissingExtensionPages, closeUnusedCreatedPages } from '../src/lib/create-extension-pages';

const origin = 'chrome-extension://test/';
const window = { id: 1, type: 'normal', incognito: false, focused: true, state: 'normal', left: 0, top: 0, width: 1000, height: 800 };
const tab = (id: number, url = origin + 'options.html', extra: Partial<ExtensionTab> = {}): ExtensionTab =>
  ({ id, windowId: 1, index: id - 1, url, active: false, pinned: false, groupId: -1, ...extra });
const state = (tabs: ExtensionTab[] = []): ExtensionPages => ({ tabs, windows: [window], sidePanelUrls: [] });

test('快照只记录目标扩展页面，URL 参数、重复标签和侧边栏路径分别保留', async () => {
  const result = await captureExtensionPages({
    tabs: { query: async () => [tab(1), tab(2), tab(3, origin + 'options.html?q=1#search'), tab(4, 'https://example.com/'), tab(5, 'chrome-extension://other/options.html')] },
    windows: { getAll: async () => [window] },
  }, 'test', [origin + 'panel.html']);
  expect(result.tabs.map(item => item.id)).toEqual([1, 2, 3]);
  expect(result.tabs[2]!.url).toBe(origin + 'options.html?q=1#search');
  expect(result.sidePanelUrls).toEqual([origin + 'panel.html']);
});

test('按页面数量补缺，不重复打开已存活或由扩展自行重开的页面', async () => {
  const calls: unknown[] = [];
  await createMissingExtensionPages({ send: async (method: string, params: object) => {
    calls.push([method, params]); return { targetId: 'new' };
  } } as any, state([tab(1), tab(2), tab(3, origin + 'popup.html')]), state([tab(10), tab(3, origin + 'popup.html')]), async () => 11);
  expect(calls).toEqual([['Target.createTarget', { url: origin + 'options.html', background: true }]]);
});

test('最后一个扩展页导致窗口关闭时创建新窗口并返回 ID 映射', async () => {
  const calls: any[] = [];
  const result = await createMissingExtensionPages({ send: async (method: string, params: object) => {
    calls.push([method, params]); return method === 'Target.createTarget' ? { targetId: 'new' } : { windowId: 9 };
  } } as any, state([tab(1), tab(2)]), { ...state(), windows: [] }, async () => 10);
  expect(result).toEqual({ windowIds: { 1: 9 }, createdTargets: [{ tabId: 10, targetId: 'new' }, { tabId: 10, targetId: 'new' }] });
  expect(calls[0][1]).toMatchObject({ newWindow: true, background: true, url: origin + 'options.html' });
  expect(calls.filter(call => call[0] === 'Target.createTarget')).toHaveLength(2);
  expect(calls.at(-1)[1].newWindow).toBeUndefined();
});

test('浏览器已在替代窗口恢复页面时复用窗口，避免额外打开相同设置页', async () => {
  const calls: any[] = [];
  const current = { ...state([tab(10, origin + 'options.html', { windowId: 9 })]), windows: [{ ...window, id: 9 }] };
  const result = await createMissingExtensionPages({ send: async (...args: any[]) => { calls.push(args); } } as any, state([tab(1)]), current);
  expect(result).toEqual({ windowIds: { 1: 9 }, createdTargets: [] });
  expect(calls).toEqual([]);
});

test('恢复窗口、顺序、固定和激活状态，仅处理目标页面', async () => {
  const calls: any[] = [];
  const original = state([tab(1, origin + 'options.html', { pinned: true, active: true, mutedInfo: { muted: true } }), tab(2)]);
  const api = {
    tabs: {
      query: async () => [tab(10), tab(11), tab(12, 'https://example.com/')],
      update: async (id: number, properties: object) => { calls.push(['update', id, properties]); },
      move: async (id: number, properties: object) => { calls.push(['move', id, properties]); },
    },
    windows: { getAll: async () => [window] },
  };
  const result = await restoreExtensionPages(api, original);
  expect(result).toEqual({ windowIds: { 1: 1 }, tabIds: { 1: 10, 2: 11 }, errors: [] });
  expect(calls).toEqual([
    ['update', 10, { pinned: true, muted: true }], ['move', 10, { windowId: 1, index: 0 }],
    ['update', 11, { pinned: false, muted: false }], ['move', 11, { windowId: 1, index: 1 }],
    ['update', 10, { active: true }],
  ]);
});

test('跨窗口恢复不占用其他原有页面，单项失败后继续并报告', async () => {
  const moved: number[] = [];
  const saved = { ...state([tab(1), tab(2, origin + 'options.html', { windowId: 2 }), tab(3, origin + 'other.html', { windowId: 2 })]), windows: [window, { ...window, id: 2 }] };
  const result = await restoreExtensionPages({
    tabs: {
      query: async () => [tab(2, origin + 'options.html', { windowId: 2 }), tab(10, origin + 'options.html', { windowId: 2 }), tab(11, origin + 'other.html', { windowId: 2 })],
      update: async (id: number) => { if (id === 10) throw new Error('测试失败'); },
      move: async (id: number) => { moved.push(id); },
    },
    windows: { getAll: async () => saved.windows },
  }, saved);
  expect(result.tabIds[2]).toBe(2);
  expect(moved).toEqual([2, 11]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('测试失败');
});

test('浏览器延后恢复原标签时，只关闭本次补建的多余页面', async () => {
  const calls: any[] = [];
  await closeUnusedCreatedPages({ send: async (...args: any[]) => { calls.push(args); } } as any,
    [{ tabId: 10, targetId: 'extra' }, { tabId: 11, targetId: 'used' }], { 1: 1, 2: 11 });
  expect(calls).toEqual([['Target.closeTarget', { targetId: 'extra' }]]);
});

test('跨窗口补回固定标签时，移动完成后再恢复固定状态和顺序', async () => {
  const calls: any[] = [];
  await restoreExtensionPages({
    tabs: {
      query: async () => [tab(10, origin + 'options.html', { windowId: 2 })],
      update: async (...args: any[]) => { calls.push(['update', ...args]); },
      move: async (...args: any[]) => { calls.push(['move', ...args]); },
    },
    windows: { getAll: async () => [window, { ...window, id: 2 }] },
  }, state([tab(1, origin + 'options.html', { pinned: true })]));
  expect(calls).toEqual([
    ['update', 10, { pinned: false }], ['move', 10, { windowId: 1, index: -1 }],
    ['update', 10, { pinned: true, muted: false }], ['move', 10, { windowId: 1, index: 0 }],
  ]);
});
