import type { CDPSession } from 'playwright-core';
import { captureExtensionPages, prepareForegroundExtensionTab, restoreExtensionPages, type ExtensionPages } from './extension-pages.js';
import { captureExtensionSnapshot, withExtensionPage } from './extension-snapshot.js';
import { captureSidePanels, restoreSidePanels } from './extension-side-panels.js';
import { createMissingExtensionPages, closeUnusedCreatedPages, type PreparedExtensionTab } from './create-extension-pages.js';
import { evaluateTarget } from './target-evaluate.js';
import { reloadManagedExtension } from './reload-managed-extension.js';

/** 隐藏的管理页提供正式重载接口，不改变当前标签或扩展的安装方式。 */
export async function reloadFromExtensionManager(cdp: CDPSession, extensionId: string): Promise<void> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', hidden: true });
  let sessionId: string | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const loaded = new Set<string>();
  let onLoad: ((loaderId: string) => void) | undefined;
  const receive = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    } else if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') {
      loaded.add(message.params.loaderId);
      onLoad?.(message.params.loaderId);
    }
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    void cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    }).catch(error => { pending.delete(id); reject(error); });
  });
  cdp.on('Target.receivedMessageFromTarget', receive);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('扩展管理页重载在 10 秒内未完成。')), 10000);
    });
    await Promise.race([timeout, (async () => {
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false }));
      await send('Page.enable');
      await send('Page.setLifecycleEventsEnabled', { enabled: true });
      const navigation = await send('Page.navigate', { url: 'chrome://extensions/' });
      if (navigation.errorText) throw new Error(navigation.errorText);
      if (!loaded.has(navigation.loaderId)) {
        await new Promise<void>(resolve => {
          onLoad = loaderId => { if (loaderId === navigation.loaderId) resolve(); };
        });
      }
      const evaluate = async <T>(expression: string): Promise<T> => {
        const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        }
        return response.result?.value as T;
      };
      const info = await evaluate<{ state?: string; views?: { type: string; url: string; isIframe?: boolean }[] }>(`chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extensionId)})`);
      const sidePanelUrls = [...new Set((info.views || [])
        .filter(view => view.type === 'EXTENSION_SIDE_PANEL' && !view.isIframe).map(view => view.url))];
      const hasNewTabView = info.views?.some(view => !view.isIframe && /^(chrome|edge):\/\/newtab\/?$/.test(view.url)) ?? false;
      const snapshot = await captureExtensionSnapshot(cdp, extensionId, sidePanelUrls, hasNewTabView);
      const panels = await captureSidePanels(cdp, snapshot.sidePanelUrls);
      const reloaded = await evaluate<boolean>(`(${reloadManagedExtension.toString()})(chrome.developerPrivate, ${JSON.stringify(extensionId)}, ${info.state === 'DISABLED'})`);
      if (reloaded !== true) throw new Error('扩展管理页未确认重载成功。');
      try {
        let restored: Awaited<ReturnType<typeof restoreExtensionPages>> = { windowIds: {}, tabIds: {}, errors: [] };
        if (snapshot.tabs.length) {
          // 快照与恢复复用同一个扩展上下文，避免重复加载完整的新标签页应用。
          const restore = async (targetId: string) => {
            const origin = `chrome-extension://${extensionId}`;
            const prepared = await evaluateTarget<PreparedExtensionTab | undefined>(cdp, targetId,
              `(${prepareForegroundExtensionTab.toString()})(chrome, ${JSON.stringify(snapshot)})`, false, origin);
            const current = await evaluateTarget<ExtensionPages>(cdp, targetId,
              `(${captureExtensionPages.toString()})(chrome, ${JSON.stringify(extensionId)}, [], ${JSON.stringify([...snapshot.tabs.map(tab => tab.id), ...(prepared ? [prepared.tabId] : [])])})`, false, origin);
            const created = await createMissingExtensionPages(cdp, snapshot, current, undefined, prepared,
              (saved, windowId, index) => evaluateTarget<number>(cdp, targetId,
                `chrome.tabs.create(${JSON.stringify({ url: saved.navigationUrl, windowId, index, active: false, pinned: saved.pinned })}).then(tab => tab.id)`, false, origin));
            const result = await evaluateTarget<typeof restored>(cdp, targetId,
              `(${restoreExtensionPages.toString()})(chrome, ${JSON.stringify(snapshot)}, ${JSON.stringify(created.windowIds)}, ${JSON.stringify(created.tabIds)})`, false, origin);
            if (!result.errors.length) await closeUnusedCreatedPages(cdp, created.createdTargets, result.tabIds,
              ids => evaluateTarget<void>(cdp, targetId, `chrome.tabs.remove(${JSON.stringify(ids)})`, false, origin));
            return result;
          };
          const result = await withExtensionPage(cdp, extensionId, targetId => restore(targetId), true);
          if (!result) throw new Error('未找到恢复后的扩展页面');
          restored = result;
        }
        const panelErrors = await restoreSidePanels(cdp, extensionId, panels, restored.windowIds, restored.tabIds);
        const errors = [...restored.errors, ...panelErrors];
        if (errors.length) throw new Error(errors.join('\n'));
      } catch (error) {
        throw new Error(`扩展已重载，但部分界面未能恢复：${(error as Error).message}`);
      }
    })()]);
  } finally {
    clearTimeout(timer);
    cdp.off('Target.receivedMessageFromTarget', receive);
    onLoad = undefined;
    for (const request of pending.values()) request.reject(new Error('扩展管理页连接已关闭。'));
    pending.clear();
    await cdp.send('Target.closeTarget', { targetId });
  }
}
