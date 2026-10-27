import type { CDPSession } from 'playwright-core';
import type { ExtensionPages } from './extension-pages.js';
import { evaluateTarget } from './target-evaluate.js';

/** 页面创建通过浏览器 CDP 完成，避免 WebUI 调用 tabs.create 的浏览器崩溃。 */
export async function createMissingExtensionPages(cdp: CDPSession, snapshot: ExtensionPages, current: ExtensionPages, readTabId = async (targetId: string, url: string) =>
  evaluateTarget<number>(cdp, targetId, 'chrome.tabs.getCurrent().then(tab => tab.id)', false, url.match(/^chrome-extension:\/\/[^/]+/)?.[0]),
): Promise<{ windowIds: Record<number, number>; createdTargets: { tabId: number; targetId: string }[] }> {
  const windowIds: Record<number, number> = {};
  const createdTargets: { tabId: number; targetId: string }[] = [];
  const used = new Set<number>();
  const reservedWindows = new Set(snapshot.windows.filter(window => current.windows.some(item => item.id === window.id)).map(window => window.id));
  const replacements = new Set<number>();
  for (const window of snapshot.windows) {
    let destination = current.windows.some(item => item.id === window.id) ? window.id : undefined;
    const savedTabs = snapshot.tabs.filter(tab => tab.windowId === window.id).sort((a, b) => a.index - b.index);
    if (destination == null) {
      const replacement = current.tabs.find(tab => savedTabs.some(saved => saved.url === tab.url) &&
        !reservedWindows.has(tab.windowId) && !replacements.has(tab.windowId));
      if (replacement) {
        destination = replacement.windowId;
        replacements.add(destination);
        windowIds[window.id] = destination;
      }
    }
    for (const saved of savedTabs) {
      const existing = current.tabs.find(tab => !used.has(tab.id) && tab.windowId === destination &&
        (tab.id === saved.id || tab.url === saved.url));
      if (existing) { used.add(existing.id); continue; }
      const { targetId } = await cdp.send('Target.createTarget', {
        url: saved.url, background: true,
        ...(destination == null ? {
          newWindow: true, left: window.left, top: window.top, width: window.width, height: window.height,
        } : {}),
      });
      createdTargets.push({ tabId: await readTabId(targetId, saved.url), targetId });
      if (destination == null) {
        ({ windowId: destination } = await cdp.send('Browser.getWindowForTarget', { targetId }));
        windowIds[window.id] = destination;
      }
    }
  }
  return { windowIds, createdTargets };
}

/** 浏览器延后恢复原标签时，只关闭本次补建且未使用的 target。 */
export async function closeUnusedCreatedPages(cdp: CDPSession, created: { tabId: number; targetId: string }[], restored: Record<number, number>): Promise<void> {
  const used = new Set(Object.values(restored));
  for (const target of created) {
    if (!used.has(target.tabId)) await cdp.send('Target.closeTarget', { targetId: target.targetId });
  }
}
