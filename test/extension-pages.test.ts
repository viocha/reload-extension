import { expect, test } from 'bun:test';
import { captureExtensionPages, prepareForegroundExtensionTab, restoreExtensionPages, type ExtensionPages, type ExtensionTab } from '../src/lib/extension-pages';
import { createMissingExtensionPages, closeUnusedCreatedPages } from '../src/lib/create-extension-pages';

const origin = 'chrome-extension://test/';
const window = { id: 1, type: 'normal', incognito: false, focused: true, state: 'normal', left: 0, top: 0, width: 1000, height: 800 };
const tab = (id: number, url = origin + 'options.html', extra: Partial<ExtensionTab> = {}): ExtensionTab =>
  ({ id, windowId: 1, index: id - 1, url, active: false, pinned: false, groupId: -1, ...extra });
const state = (tabs: ExtensionTab[] = []): ExtensionPages => ({ tabs, windows: [window], sidePanelUrls: [] });

test('缺失的当前常规扩展页先创建并激活，后台页的上下文等待不阻塞当前页', async () => {
  const actions: string[] = [];
  const snapshot = state([tab(1, origin + 'options.html', { active: true, pinned: true }), tab(2, origin + 'other.html')]);
  const current = state();
  const prepared = await prepareForegroundExtensionTab({
    tabs: {
      query: async () => [],
      create: async (properties: any) => {
        expect(properties).toEqual({ url: origin + 'options.html', windowId: 1, index: 0, active: true, pinned: true });
        actions.push('foreground-active');
        current.tabs.push(tab(10, properties.url, properties));
        return { id: 10 };
      },
    }, windows: { getAll: async () => [window] },
  }, snapshot);
  const background = Promise.withResolvers<number>();
  const started = Promise.withResolvers<void>();
  const creating = createMissingExtensionPages({ send: async () => ({ targetId: 'background' }) } as any,
    snapshot, current, async () => { actions.push('background-wait'); started.resolve(); return background.promise; }, prepared);
  await started.promise;
  expect(actions).toEqual(['foreground-active', 'background-wait']);
  background.resolve(11);
  expect((await creating).tabIds).toEqual({ 1: 10 });
});

test('存活的当前页优先于同 URL 副本复用，已激活时不重复更新', async () => {
  const updates: any[] = [];
  const saved = tab(1, origin + 'options.html', { active: true });
  const api = { tabs: {
    query: async () => [tab(10), saved],
    update: async (...args: any[]) => { updates.push(args); },
    create: async () => { throw new Error('存活页不应重建'); },
  } };
  expect(await prepareForegroundExtensionTab(api, state([saved]))).toBeUndefined();
  expect(updates).toEqual([]);
  saved.active = false;
  await prepareForegroundExtensionTab(api, state([{ ...saved, active: true }]));
  expect(updates).toEqual([[1, { active: true }]]);
});

test('自行补建的当前页直接激活，不占用其他原有的同 URL 标签', async () => {
  const updates: any[] = [];
  await prepareForegroundExtensionTab({ tabs: {
    query: async () => [tab(2), tab(10)],
    update: async (...args: any[]) => { updates.push(args); },
  } }, state([tab(1, origin + 'options.html', { active: true }), tab(2)]));
  expect(updates).toEqual([[10, { active: true }]]);
});

test('后台窗口的扩展页不抢占当前页，原窗口已关闭时交由窗口恢复处理', async () => {
  const api = { tabs: { query: async () => [] }, windows: { getAll: async () => [] } };
  const snapshot = state([tab(1, origin + 'options.html', { active: true })]);
  expect(await prepareForegroundExtensionTab(api, snapshot)).toBeUndefined();
  snapshot.windows = [{ ...window, focused: false }];
  // 无前台目标时无需调用任何浏览器 API。
  expect(await prepareForegroundExtensionTab({}, snapshot)).toBeUndefined();
});

test('快照只记录目标扩展页面，URL 参数、重复标签和侧边栏路径分别保留', async () => {
  const result = await captureExtensionPages({
    extension: { getViews: () => [] },
    tabs: { query: async () => [tab(1), tab(2), tab(3, origin + 'options.html?q=1#search'), tab(4, 'https://example.com/'), tab(5, 'chrome-extension://other/options.html')] },
    windows: { getAll: async () => [window] },
  }, 'test', [origin + 'panel.html']);
  expect(result.tabs.map(item => item.id)).toEqual([1, 2, 3]);
  expect(result.tabs[2]!.url).toBe(origin + 'options.html?q=1#search');
  expect(result.sidePanelUrls).toEqual([origin + 'panel.html']);
});

test('新标签页按自身视图记录实际文档和入口，不收录其他扩展或原生新标签页', async () => {
  const view = (id: number, url: string) => ({ location: { href: url }, chrome: { tabs: { getCurrent: async () => ({ id }) } } });
  const result = await captureExtensionPages({
    tabs: { query: async () => [tab(1, 'edge://newtab/'), tab(2, 'chrome://newtab/'), tab(3, 'edge://newtab/'), tab(4, 'edge://newtab/'), tab(5, 'https://example.com/')] },
    windows: { getAll: async () => [window] },
    extension: { getViews: () => [view(1, origin + 'newtab.html'), view(2, origin + 'newtab.html'), view(3, 'chrome-extension://other/newtab.html')] },
  }, 'test');
  expect(result.tabs).toEqual([
    tab(1, origin + 'newtab.html', { navigationUrl: 'edge://newtab/' }),
    tab(2, origin + 'newtab.html', { navigationUrl: 'chrome://newtab/' }),
  ]);
});

test('重载后的原生新标签页按已记录 ID 追踪，通过真正新标签页入口创建替代标签', async () => {
  const saved = state([tab(1, origin + 'newtab.html', { navigationUrl: 'edge://newtab/' })]);
  const current = await captureExtensionPages({
    tabs: { query: async () => [tab(1, 'edge://newtab/'), tab(2, 'edge://newtab/')] },
    windows: { getAll: async () => [window] }, extension: { getViews: () => [] },
  }, 'test');
  expect(current.tabs).toEqual([]);
  const tracked = await captureExtensionPages({
    tabs: { query: async () => [tab(1, 'edge://newtab/'), tab(2, 'edge://newtab/')] },
    windows: { getAll: async () => [window] }, extension: { getViews: () => [] },
  }, 'test', [], [1]);
  expect(tracked.tabs.map(tab => tab.id)).toEqual([1]);
  const calls: any[] = [];
  const created = await createMissingExtensionPages({ send: async (method: string, params: any) => {
    calls.push([method, params]); return { targetId: 'newtab' };
  } } as any, saved, tracked, async () => 10);
  expect(calls).toEqual([['Target.createTarget', { url: 'edge://newtab/', background: true }]]);
  expect(created.tabIds).toEqual({ 1: 10 });
});

test('失效视图不阻断其他新标签页的快照，准备离开的标签不纳入恢复', async () => {
  const result = await captureExtensionPages({
    tabs: { query: async () => [tab(1, 'edge://newtab/'), { ...tab(2, 'edge://newtab/'), pendingUrl: 'https://example.com/' }] },
    windows: { getAll: async () => [window] },
    extension: { getViews: () => [
      { chrome: { tabs: { getCurrent: async () => { throw new Error('Extension context invalidated.'); } } } },
      ...[1, 2].map(id => ({ location: { href: origin + 'newtab.html' }, chrome: { tabs: { getCurrent: async () => ({ id }) } } })),
    ] },
  }, 'test');
  expect(result.tabs.map(tab => tab.id)).toEqual([1]);
});

test('新标签页恢复原位置和固定状态后关闭原标签，保留其他原生新标签页', async () => {
  const calls: any[] = [];
  const saved = state([tab(1, origin + 'newtab.html', { navigationUrl: 'edge://newtab/', pinned: true })]);
  const result = await restoreExtensionPages({
    tabs: {
      query: async () => [tab(1, 'edge://newtab/'), tab(2, 'edge://newtab/'), tab(10, 'edge://newtab/')],
      update: async (...args: any[]) => { calls.push(['update', ...args]); },
      move: async (...args: any[]) => { calls.push(['move', ...args]); },
      remove: async (...args: any[]) => { calls.push(['remove', ...args]); },
    }, windows: { getAll: async () => [window] },
  }, saved, {}, { 1: 10 });
  expect(result.tabIds).toEqual({ 1: 10 });
  expect(result.errors).toEqual([]);
  expect(calls).toEqual([
    ['update', 10, { pinned: true }], ['move', 10, { windowId: 1, index: 0 }],
    ['remove', [1]],
  ]);
});

test('按页面数量补缺，不重复打开已存活或由扩展自行重开的页面', async () => {
  const calls: unknown[] = [];
  await createMissingExtensionPages({ send: async (method: string, params: object) => {
    calls.push([method, params]); return { targetId: 'new' };
  } } as any, state([tab(1), tab(2), tab(3, origin + 'popup.html')]), state([tab(10), tab(3, origin + 'popup.html')]), async () => 11);
  expect(calls).toEqual([['Target.createTarget', { url: origin + 'options.html', background: true }]]);
});

test('新标签页恢复失败时保留原标签并报告错误', async () => {
  const removed: number[] = [];
  const result = await restoreExtensionPages({
    tabs: {
      query: async () => [tab(1, 'edge://newtab/'), tab(10, 'edge://newtab/')],
      update: async () => {},
      move: async () => { throw new Error('恢复位置失败'); },
      remove: async (id: number) => { removed.push(id); },
    }, windows: { getAll: async () => [window] },
  }, state([tab(1, origin + 'newtab.html', { navigationUrl: 'edge://newtab/' })]), {}, { 1: 10 });
  expect(removed).toEqual([]);
  expect(result.errors).toEqual([origin + 'newtab.html: 恢复位置失败']);
});

test('批量替换交错的新标签页时保留普通标签位置，并先激活新页再关闭原页', async () => {
  let live = [
    tab(20, 'https://first.example/', { index: 0 }),
    tab(1, 'edge://newtab/', { index: 1 }),
    tab(21, 'https://middle.example/', { index: 2 }),
    tab(2, 'edge://newtab/', { index: 3, active: true }),
    tab(22, 'https://last.example/', { index: 4 }),
    tab(10, 'edge://newtab/', { index: 5 }),
    tab(11, 'edge://newtab/', { index: 6 }),
  ];
  const actions: any[] = [];
  const result = await restoreExtensionPages({
    tabs: {
      query: async () => live.map(item => ({ ...item })),
      update: async (id: number, properties: any) => {
        actions.push(['update', id, properties]);
        Object.assign(live.find(item => item.id === id)!, properties);
      },
      move: async (id: number, { index }: { index: number }) => {
        const [item] = live.splice(live.findIndex(item => item.id === id), 1);
        live.splice(index, 0, item!);
      },
      remove: async (ids: number[]) => {
        actions.push(['remove', ids]);
        live = live.filter(item => !ids.includes(item.id));
      },
    }, windows: { getAll: async () => [window] },
  }, state([
    tab(1, origin + 'newtab.html', { index: 1, navigationUrl: 'edge://newtab/' }),
    tab(2, origin + 'newtab.html', { index: 3, active: true, navigationUrl: 'edge://newtab/' }),
  ]), {}, { 1: 10, 2: 11 });
  expect(result.errors).toEqual([]);
  expect(live.map(item => item.id)).toEqual([20, 10, 21, 11, 22]);
  expect(actions).toEqual([['update', 11, { active: true }], ['remove', [1, 2]]]);
});

test('原新标签页已关闭时通过原入口创建，Chrome 和 Edge 均保留新标签页语义', async () => {
  for (const navigationUrl of ['chrome://newtab/', 'edge://newtab/']) {
    const calls: any[] = [];
    const created = await createMissingExtensionPages({ send: async (method: string, params: any) => {
      calls.push([method, params]); return { targetId: 'newtab' };
    } } as any, state([tab(1, origin + 'newtab.html', { navigationUrl })]), state(), async () => 10);
    expect(created.tabIds).toEqual({ 1: 10 });
    expect(calls).toEqual([['Target.createTarget', { url: navigationUrl, background: true }]]);
  }
});

test('独立标签页并发等待上下文，前一个标签未就绪时也能创建后一个', async () => {
  const first = Promise.withResolvers<number>();
  let count = 0;
  const result = await createMissingExtensionPages({ send: async () => {
    count++;
    if (count === 2) first.resolve(10);
    return { targetId: 'target-' + count };
  } } as any, state([tab(1), tab(2)]), state(), async targetId => targetId === 'target-1' ? first.promise : 11);
  expect(count).toBe(2);
  expect(result.createdTargets.map(target => target.tabId).sort()).toEqual([10, 11]);
});

test('立即打开的当前新标签页复用为恢复目标，原窗口已关闭时也不重复创建', async () => {
  const calls: string[] = [];
  const snapshot = state([tab(1, origin + 'newtab.html', { navigationUrl: 'edge://newtab/', active: true })]);
  const current = { ...state([tab(99, 'edge://newtab/', { windowId: 9, active: true })]), windows: [{ ...window, id: 9 }] };
  const result = await createMissingExtensionPages({ send: async (method: string) => { calls.push(method); } } as any,
    snapshot, current, undefined, { sourceTabId: 1, tabId: 99, targetId: 'foreground' });
  expect(calls).toEqual([]);
  expect(result).toEqual({ windowIds: { 1: 9 }, tabIds: { 1: 99 }, createdTargets: [{ tabId: 99, targetId: 'foreground' }] });
});

test('多个新标签均直接插入原页左侧，关闭原页前不移动替代标签', async () => {
  const snapshot = state([1, 2, 3].map(id => tab(id, origin + 'newtab.html', {
    index: id * 2 - 1, navigationUrl: 'edge://newtab/', active: id === 1,
  })));
  let live = [
    tab(20, 'https://first.example/'), tab(10, 'edge://newtab/', { active: true }), tab(1, 'edge://newtab/'),
    tab(21, 'https://middle.example/'), tab(2, 'edge://newtab/'),
    tab(22, 'https://last.example/'), tab(3, 'edge://newtab/'),
  ];
  const current = state(live.map((item, index) => ({ ...item, index })));
  const insertions: any[] = [];
  const moved: number[] = [];
  const created = await createMissingExtensionPages({ send: async () => { throw new Error('新标签不应在末尾创建'); } } as any,
    snapshot, current, async () => { throw new Error('不应等待页面加载'); }, { sourceTabId: 1, tabId: 10 },
    async (saved, windowId, index) => {
      insertions.push([saved.id, windowId, index]);
      const id = saved.id + 100;
      live.splice(index, 0, tab(id, 'edge://newtab/'));
      return id;
    });
  const result = await restoreExtensionPages({
    tabs: {
      query: async () => live.map((item, index) => ({ ...item, index })),
      move: async (id: number, { index }: { index: number }) => {
        const oldIndex = live.findIndex(item => item.id === id);
        if (oldIndex !== index) moved.push(id);
        const [item] = live.splice(oldIndex, 1);
        live.splice(index, 0, item!);
      },
      update: async () => {},
      remove: async (ids: number[]) => { live = live.filter(item => !ids.includes(item.id)); },
    }, windows: { getAll: async () => [window] },
  }, snapshot, created.windowIds, created.tabIds);
  expect(insertions).toEqual([[3, 1, 6], [2, 1, 4]]);
  expect(moved).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(live.map(item => item.id)).toEqual([20, 10, 21, 102, 22, 103]);
});

test('最后一个扩展页导致窗口关闭时创建新窗口并返回 ID 映射', async () => {
  const calls: any[] = [];
  const result = await createMissingExtensionPages({ send: async (method: string, params: object) => {
    calls.push([method, params]); return method === 'Target.createTarget' ? { targetId: 'new' } : { windowId: 9 };
  } } as any, state([tab(1), tab(2)]), { ...state(), windows: [] }, async () => 10);
  expect(result).toEqual({ windowIds: { 1: 9 }, tabIds: {}, createdTargets: [{ tabId: 10, targetId: 'new' }, { tabId: 10, targetId: 'new' }] });
  expect(calls[0][1]).toMatchObject({ newWindow: true, background: true, url: origin + 'options.html' });
  expect(calls.filter(call => call[0] === 'Target.createTarget')).toHaveLength(2);
  expect(calls.at(-1)[1].newWindow).toBeUndefined();
});

test('浏览器已在替代窗口恢复页面时复用窗口，避免额外打开相同设置页', async () => {
  const calls: any[] = [];
  const current = { ...state([tab(10, origin + 'options.html', { windowId: 9 })]), windows: [{ ...window, id: 9 }] };
  const result = await createMissingExtensionPages({ send: async (...args: any[]) => { calls.push(args); } } as any, state([tab(1)]), current);
  expect(result).toEqual({ windowIds: { 1: 9 }, tabIds: {}, createdTargets: [] });
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
    ['move', 11, { windowId: 1, index: 1 }],
    ['update', 10, { active: true }],
  ]);
});

test('跨窗口恢复不占用其他原有页面，单项失败后继续并报告', async () => {
  const moved: number[] = [];
  const saved = { ...state([tab(1), tab(2, origin + 'options.html', { windowId: 2 }), tab(3, origin + 'other.html', { windowId: 2 })]), windows: [window, { ...window, id: 2 }] };
  const result = await restoreExtensionPages({
    tabs: {
      query: async () => [tab(2, origin + 'options.html', { windowId: 2 }), tab(10, origin + 'options.html', { windowId: 2 }), tab(11, origin + 'other.html', { windowId: 2 })],
      update: async () => {},
      move: async (id: number) => { if (id === 10) throw new Error('测试失败'); moved.push(id); },
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

test('通过标签页 API 创建的多余页面也按数量清理', async () => {
  const removed: number[][] = [];
  await closeUnusedCreatedPages({ send: async () => { throw new Error('不应使用未知 target'); } } as any,
    [{ tabId: 10 }, { tabId: 11 }], { 1: 11 }, async ids => { removed.push(ids); });
  expect(removed).toEqual([[10]]);
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
    ['move', 10, { windowId: 1, index: -1 }],
    ['update', 10, { pinned: true }], ['move', 10, { windowId: 1, index: 0 }],
  ]);
});
