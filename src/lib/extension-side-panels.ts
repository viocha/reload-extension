import type { CDPSession } from 'playwright-core';
import { evaluateTarget } from './target-evaluate.js';

interface SidePanel {
  url: string;
  windowId: number;
  tabId?: number;
  path: string;
  browserContextId?: string;
}

export async function captureSidePanels(cdp: CDPSession, urls: string[]): Promise<SidePanel[]> {
  if (!urls.length) return [];
  const { targetInfos } = await cdp.send('Target.getTargets');
  const panels: SidePanel[] = [];
  for (const target of targetInfos.filter(item => item.type === 'page' && urls.includes(item.url))) {
    const panel = await evaluateTarget<Omit<SidePanel, 'browserContextId'> | null>(cdp, target.targetId, `
      (async () => {
        if (document.visibilityState !== 'visible' || await chrome.tabs.getCurrent()) return null;
        const window = await chrome.windows.getCurrent();
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [location.href] });
        if (!contexts.length) return null;
        const [active] = await chrome.tabs.query({ active: true, windowId: window.id });
        const options = await chrome.sidePanel.getOptions(active ? { tabId: active.id } : {});
        return { url: location.href, windowId: window.id, tabId: options.tabId, path: options.path };
      })()
    `, false, target.url.match(/^chrome-extension:\/\/[^/]+/)?.[0]);
    if (panel) panels.push({ ...panel, browserContextId: target.browserContextId });
  }
  return panels;
}

export async function restoreSidePanels(
  cdp: CDPSession,
  extensionId: string,
  panels: SidePanel[],
  windowIds: Record<number, number>,
  tabIds: Record<number, number>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const panel of panels) {
    let helperTarget: string | undefined;
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const prefix = `chrome-extension://${extensionId}/`;
      const target = targetInfos.find(item => item.url.startsWith(prefix) &&
        ['page', 'background_page'].includes(item.type) && item.browserContextId === panel.browserContextId);
      let targetId = target?.targetId;
      if (!targetId) {
        ({ targetId } = await cdp.send('Target.createTarget', {
          url: panel.url, hidden: true,
          ...(panel.browserContextId ? { browserContextId: panel.browserContextId } : {}),
        }));
        helperTarget = targetId;
      }
      const windowId = windowIds[panel.windowId] ?? panel.windowId;
      const tabId = panel.tabId == null ? undefined : tabIds[panel.tabId] ?? panel.tabId;
      const options = { path: panel.path, enabled: true, ...(tabId == null ? {} : { tabId }) };
      await evaluateTarget(cdp, targetId, `
        (async () => {
          await chrome.sidePanel.setOptions(${JSON.stringify(options)});
          await chrome.sidePanel.open(${JSON.stringify(tabId == null ? { windowId } : { tabId })});
          return true;
        })()
      `, true, `chrome-extension://${extensionId}`);
    } catch (error) {
      errors.push(`侧边栏 ${panel.url}: ${(error as Error).message}`);
    } finally {
      if (helperTarget) await cdp.send('Target.closeTarget', { targetId: helperTarget });
    }
  }
  return errors;
}
