import type { CDPSession } from 'playwright-core';
import type { ExtensionPages, ExtensionTab } from './extension-pages.js';
import { evaluateTarget } from './target-evaluate.js';

export interface PreparedExtensionTab {
  sourceTabId: number;
  tabId: number;
  targetId?: string;
}

export interface CreatedExtensionTab { tabId: number; targetId?: string }

/** 新标签页由扩展上下文按索引创建；普通扩展页及缺失窗口通过 CDP 补建。 */
export async function createMissingExtensionPages(cdp: CDPSession, snapshot: ExtensionPages, current: ExtensionPages, readTabId = async (targetId: string, url: string) =>
  evaluateTarget<number>(cdp, targetId, 'chrome.tabs.getCurrent().then(tab => tab.id)', false, url.match(/^chrome-extension:\/\/[^/]+/)?.[0]),
  prepared?: PreparedExtensionTab,
  createNewTab?: (saved: ExtensionTab, windowId: number, index: number) => Promise<number>,
): Promise<{ windowIds: Record<number, number>; tabIds: Record<number, number>; createdTargets: CreatedExtensionTab[] }> {
  const windowIds: Record<number, number> = {};
  const tabIds: Record<number, number> = prepared ? { [prepared.sourceTabId]: prepared.tabId } : {};
  const createdTargets: CreatedExtensionTab[] = prepared ? [{ tabId: prepared.tabId, ...(prepared.targetId ? { targetId: prepared.targetId } : {}) }] : [];
  const preparing: Promise<void>[] = [];
  const preparationErrors: unknown[] = [];
  const used = new Set<number>();
  const reservedWindows = new Set(snapshot.windows.filter(window => current.windows.some(item => item.id === window.id)).map(window => window.id));
  const replacements = new Set<number>();
  try {
    for (const window of snapshot.windows) {
      let destination = current.windows.some(item => item.id === window.id) ? window.id : undefined;
      const savedTabs = snapshot.tabs.filter(tab => tab.windowId === window.id).sort((a, b) => a.index - b.index);
      if (destination == null) {
        const replacement = current.tabs.find(tab => savedTabs.some(saved => saved.url === tab.url || tabIds[saved.id] === tab.id) &&
          !reservedWindows.has(tab.windowId) && !replacements.has(tab.windowId));
        if (replacement) {
          destination = replacement.windowId;
          replacements.add(destination);
          windowIds[window.id] = destination;
        }
      }
      // 从右向左插入，前面的原标签索引不会因后方新增页面而变化。
      for (const saved of [...savedTabs].reverse()) {
        if (tabIds[saved.id] != null) { used.add(tabIds[saved.id]!); continue; }
        const existing = current.tabs.find(tab => !used.has(tab.id) && tab.windowId === destination &&
          (tab.id === saved.id || tab.url === saved.url));
        if (existing && !saved.navigationUrl) { used.add(existing.id); continue; }
        if (saved.navigationUrl && destination != null && createNewTab) {
          const source = current.tabs.find(tab => tab.id === saved.id && tab.windowId === destination);
          const tabId = await createNewTab(saved, destination, source?.index ?? saved.index);
          createdTargets.push({ tabId });
          tabIds[saved.id] = tabId;
          continue;
        }
        // 新标签页使用新建入口重新应用覆盖；直接导航或刷新存活标签在 Edge 中并不可靠。
        const { targetId } = await cdp.send('Target.createTarget', {
          url: saved.navigationUrl ?? saved.url, background: true,
          ...(destination == null ? {
            newWindow: true, left: window.left, top: window.top, width: window.width, height: window.height,
          } : {}),
        });
        // 页面分别等待自身上下文就绪，不让前一个页面的初始化阻塞后续页面创建。
        preparing.push(readTabId(targetId, saved.url).then(tabId => {
          createdTargets.push({ tabId, targetId });
          if (saved.navigationUrl) tabIds[saved.id] = tabId;
        }, error => { preparationErrors.push(error); }));
        if (destination == null) {
          ({ windowId: destination } = await cdp.send('Browser.getWindowForTarget', { targetId }));
          windowIds[window.id] = destination;
        }
      }
    }
  } finally {
    await Promise.all(preparing);
  }
  if (preparationErrors.length) throw preparationErrors[0];
  return { windowIds, tabIds, createdTargets };
}

/** 浏览器延后恢复原标签时，只关闭本次补建且未使用的 target。 */
export async function closeUnusedCreatedPages(cdp: CDPSession, created: CreatedExtensionTab[], restored: Record<number, number>, closeTabs?: (ids: number[]) => Promise<void>): Promise<void> {
  const used = new Set(Object.values(restored));
  const unused: number[] = [];
  for (const target of created) {
    if (used.has(target.tabId)) continue;
    if (target.targetId) await cdp.send('Target.closeTarget', { targetId: target.targetId });
    else unused.push(target.tabId);
  }
  if (unused.length) {
    if (!closeTabs) throw new Error('缺少未使用标签页的清理上下文');
    await closeTabs(unused);
  }
}
