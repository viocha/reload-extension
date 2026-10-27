export interface ExtensionTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
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
}

/** 此函数通过 CDP 在扩展管理页执行，不能引用外部运行时变量。 */
export async function captureExtensionPages(api: any, extensionId: string): Promise<ExtensionPages> {
  const [allTabs, allWindows, info] = await Promise.all([
    api.tabs.query({}), api.windows.getAll(), api.developerPrivate.getExtensionInfo(extensionId),
  ]);
  const prefix = `chrome-extension://${extensionId}/`;
  const tabs = allTabs.filter((tab: any) => (tab.pendingUrl || tab.url || '').startsWith(prefix))
    .map((tab: any) => ({
      id: tab.id, windowId: tab.windowId, index: tab.index, url: tab.pendingUrl || tab.url,
      active: tab.active, pinned: tab.pinned, groupId: tab.groupId, mutedInfo: tab.mutedInfo,
    }));
  return {
    tabs,
    windows: allWindows
      .map(({ id, type, incognito, focused, state, left, top, width, height }: ExtensionWindow) =>
        ({ id, type, incognito, focused, state, left, top, width, height })),
    sidePanelUrls: [...new Set<string>((info.views || [])
      .filter((view: any) => view.type === 'EXTENSION_SIDE_PANEL' && !view.isIframe)
      .map((view: any) => view.url))],
  };
}

/** 只补回缺失页面，已有页面按数量匹配，避免扩展自行恢复后再打开一份。 */
export async function restoreExtensionPages(api: any, snapshot: ExtensionPages, createdWindowIds: Record<number, number> = {}): Promise<{
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
      windowIds[window.id] = destination.id;
      for (const saved of savedTabs) {
        try {
          let tab = tabs.find((item: any) => item.id === saved.id && item.windowId === destination.id && !used.has(item.id));
          tab ??= tabs.find((item: any) => item.windowId === destination.id &&
            (item.pendingUrl || item.url) === saved.url && !used.has(item.id));
          tab ??= tabs.find((item: any) => (item.pendingUrl || item.url) === saved.url &&
            !used.has(item.id) && !survivingIds.has(item.id));
          if (!tab) throw new Error('恢复页面未出现在标签页列表');
          used.add(tab.id);
          tabIds[saved.id] = tab.id;
          // 跨窗口移动会清除固定状态，先迁移窗口再恢复固定和最终位置。
          if (tab.windowId !== destination.id) {
            await api.tabs.update(tab.id, { pinned: false });
            await api.tabs.move(tab.id, { windowId: destination.id, index: -1 });
          }
          await api.tabs.update(tab.id, { pinned: saved.pinned, muted: saved.mutedInfo?.muted ?? false });
          await api.tabs.move(tab.id, { windowId: destination.id, index: saved.index });
          if (saved.groupId >= 0 && tabs.some((item: any) => item.groupId === saved.groupId)) {
            await api.tabs.group({ groupId: saved.groupId, tabIds: [tab.id] });
          }
        } catch (error) {
          errors.push(`${saved.url}: ${(error as Error).message}`);
        }
      }
      const active = savedTabs.find(tab => tab.active);
      if (active && tabIds[active.id] != null) await api.tabs.update(tabIds[active.id], { active: true });
      if (recreated) {
        await api.windows.update(destination.id, { state: window.state, focused: window.focused });
      }
    } catch (error) {
      errors.push(`窗口 ${window.id}: ${(error as Error).message}`);
    }
  }
  return { windowIds, tabIds, errors };
}
