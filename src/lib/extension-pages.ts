export interface ExtensionTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  /** 浏览器新标签页保留的入口地址；url 是实际扩展文档地址。 */
  navigationUrl?: string;
  active: boolean;
  pinned: boolean;
  groupId: number;
  mutedInfo?: { muted: boolean };
}

export interface ExtensionWindow {
  id: number;
  type: string;
  incognito: boolean;
  focused: boolean;
  state: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ExtensionPages {
  tabs: ExtensionTab[];
  windows: ExtensionWindow[];
  sidePanelUrls: string[];
  lastFocusedWindowId?: number;
}

/** 此函数通过 CDP 在扩展自身页面执行，不能引用外部运行时变量。 */
export async function captureExtensionPages(api: any, extensionId: string, sidePanelUrls: string[] = [], trackedTabIds: number[] = []): Promise<ExtensionPages> {
  const [allTabs, allWindows, views] = await Promise.all([
    api.tabs.query({}), api.windows.getAll(),
    // 重载时视图可能正在销毁，单个失效视图不应中断其他页面的快照。
    Promise.allSettled((trackedTabIds.length ? [] : api.extension.getViews({ type: 'tab' })).map(async (view: any) => ({
      id: (await view.chrome.tabs.getCurrent())?.id, url: view.location.href,
    }))),
  ]);
  const prefix = `chrome-extension://${extensionId}/`;
  const lastFocusedWindowId = allWindows.some((window: any) => window.focused) ? undefined : (await api.windows.getLastFocused()).id;
  const viewUrls = new Map<number, string>(views.flatMap(item => item.status === 'fulfilled' && item.value.id != null
    ? [[item.value.id, item.value.url] as [number, string]] : []));
  const tabs = allTabs.flatMap((tab: any) => {
    const url = tab.pendingUrl || tab.url || '';
    const newTab = /^(chrome|edge):\/\/newtab\/?$/.test(url);
    const viewUrl = newTab && viewUrls.get(tab.id)?.startsWith(prefix) ? viewUrls.get(tab.id) : undefined;
    if (!url.startsWith(prefix) && !viewUrl && !(newTab && trackedTabIds.includes(tab.id))) return [];
    return [{
      id: tab.id, windowId: tab.windowId, index: tab.index, url: viewUrl ?? url,
      ...(viewUrl ? { navigationUrl: url } : {}),
      active: tab.active, pinned: tab.pinned, groupId: tab.groupId, mutedInfo: tab.mutedInfo,
    }];
  });
  return {
    tabs,
    windows: allWindows
      .map(({ id, type, incognito, focused, state, left, top, width, height }: ExtensionWindow) =>
        ({ id, type, incognito, focused, state, left, top, width, height })),
    sidePanelUrls,
    ...(lastFocusedWindowId == null ? {} : { lastFocusedWindowId }),
  };
}

/** 在扩展上下文优先恢复当前页，不等待其他页面初始化；不能引用外部运行时变量。 */
export async function prepareForegroundExtensionTab(api: any, snapshot: ExtensionPages): Promise<{ sourceTabId: number; tabId: number } | undefined> {
  const saved = snapshot.tabs.find(tab => tab.active && snapshot.windows.some(window =>
    window.id === tab.windowId && (window.focused || window.id === snapshot.lastFocusedWindowId)));
  if (!saved) return;
  const tabs = await api.tabs.query({});
  const old = tabs.find((tab: any) => tab.id === saved.id);
  if (!saved.navigationUrl) {
    // 保留同 URL 的其他原标签，优先复用当前页或扩展自行补建的页面。
    const reserved = new Set(snapshot.tabs.filter(tab => tab.id !== saved.id).map(tab => tab.id));
    const matches = (tab: any) => tab.windowId === saved.windowId &&
      (tab.pendingUrl || tab.url) === saved.url && !reserved.has(tab.id);
    const existing = old && matches(old) ? old : tabs.find(matches);
    if (existing) {
      if (!existing.active) await api.tabs.update(existing.id, { active: true });
      return;
    }
    // 用户已在原标签导航到其他页面时，不额外创建扩展页抢占当前标签。
    if (old) return;
  }
  if (!old && !(await api.windows.getAll()).some((window: any) => window.id === saved.windowId)) return;
  const tab = await api.tabs.create({
    url: saved.navigationUrl ?? saved.url, windowId: old?.windowId ?? saved.windowId,
    index: old?.index ?? saved.index, active: true, pinned: saved.pinned,
  });
  return { sourceTabId: saved.id, tabId: tab.id };
}

/** 只补回缺失页面，已有页面按数量匹配，避免扩展自行恢复后再打开一份。 */
export async function restoreExtensionPages(api: any, snapshot: ExtensionPages, createdWindowIds: Record<number, number> = {}, createdTabIds: Record<number, number> = {}): Promise<{
  windowIds: Record<number, number>;
  tabIds: Record<number, number>;
  errors: string[];
}> {
  const [tabs, windows] = await Promise.all([api.tabs.query({}), api.windows.getAll()]);
  const windowIds: Record<number, number> = {};
  const tabIds: Record<number, number> = {};
  const used = new Set<number>();
  const errors: string[] = [];
  const survivingIds = new Set(snapshot.tabs.map(tab => tab.id).filter(id => tabs.some((tab: any) => tab.id === id)));
  for (const window of snapshot.windows) {
    const savedTabs = snapshot.tabs.filter(tab => tab.windowId === window.id).sort((a, b) => a.index - b.index);
    if (!savedTabs.length) continue;
    try {
      const destination = windows.find((item: any) => item.id === (createdWindowIds[window.id] ?? window.id));
      if (!destination) throw new Error('原窗口已关闭，且未能创建恢复窗口');
      const recreated = destination.id !== window.id;
      let activatedTabId: number | undefined = tabs.find((tab: any) => tab.windowId === destination.id && tab.active)?.id;
      const pendingRemovals: number[] = [];
      windowIds[window.id] = destination.id;
      for (const saved of savedTabs) {
        try {
          const replacementId = createdTabIds[saved.id];
          let tab = tabs.find((item: any) => item.id === (replacementId ?? saved.id) && !used.has(item.id) &&
            (replacementId != null || item.windowId === destination.id));
          tab ??= tabs.find((item: any) => item.windowId === destination.id &&
            (item.pendingUrl || item.url) === saved.url && !used.has(item.id));
          tab ??= tabs.find((item: any) => (item.pendingUrl || item.url) === saved.url &&
            !used.has(item.id) && !survivingIds.has(item.id));
          if (!tab) throw new Error('恢复页面未出现在标签页列表');
          used.add(tab.id);
          tabIds[saved.id] = tab.id;
          // 跨窗口移动会清除固定状态，先迁移窗口再恢复固定和最终位置。
          if (tab.windowId !== destination.id) {
            if (tab.active) activatedTabId = undefined;
            if (tab.pinned) await api.tabs.update(tab.id, { pinned: false });
            tab.pinned = false;
            await api.tabs.move(tab.id, { windowId: destination.id, index: -1 });
          }
          const muted = saved.mutedInfo?.muted ?? false;
          const properties = {
            ...(tab.pinned !== saved.pinned ? { pinned: saved.pinned } : {}),
            ...((tab.mutedInfo?.muted ?? false) !== muted ? { muted } : {}),
          };
          if (Object.keys(properties).length) await api.tabs.update(tab.id, properties);
          // 尚未关闭的前序原标签暂时占位，批量关闭后位置恰好回到原索引。
          await api.tabs.move(tab.id, { windowId: destination.id, index: saved.index + pendingRemovals.length });
          if (saved.groupId >= 0 && tabs.some((item: any) => item.groupId === saved.groupId)) {
            await api.tabs.group({ groupId: saved.groupId, tabIds: [tab.id] });
          }
          if (replacementId != null && saved.id !== tab.id && tabs.some((item: any) => item.id === saved.id &&
            /^(chrome|edge):\/\/newtab\/?$/.test(item.pendingUrl || item.url || ''))) {
            if (saved.active && activatedTabId !== tab.id) {
              await api.tabs.update(tab.id, { active: true });
              activatedTabId = tab.id;
            }
            pendingRemovals.push(saved.id);
          }
        } catch (error) {
          errors.push(`${saved.url}: ${(error as Error).message}`);
        }
      }
      const active = savedTabs.find(tab => tab.active);
      if (active && tabIds[active.id] != null && tabIds[active.id] !== activatedTabId) await api.tabs.update(tabIds[active.id], { active: true });
      // 先完成排列再一次关闭，避免逐个等待原生新标签页的卸载回调。
      if (pendingRemovals.length) await api.tabs.remove(pendingRemovals);
      if (recreated) {
        await api.windows.update(destination.id, { state: window.state, focused: window.focused });
      }
    } catch (error) {
      errors.push(`窗口 ${window.id}: ${(error as Error).message}`);
    }
  }
  return { windowIds, tabIds, errors };
}
