import type { CDPSession } from 'playwright-core';
import { captureExtensionPages, restoreExtensionPages, type ExtensionPages } from './extension-pages.js';
import { captureSidePanels, restoreSidePanels } from './extension-side-panels.js';
import { createMissingExtensionPages, closeUnusedCreatedPages } from './create-extension-pages.js';
import { evaluateTarget } from './target-evaluate.js';

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
      const snapshot = await evaluate<ExtensionPages>(`(${captureExtensionPages.toString()})(chrome, ${JSON.stringify(extensionId)})`);
      const panels = await captureSidePanels(cdp, snapshot.sidePanelUrls);
      const response = await send('Runtime.evaluate', {
        expression: `chrome.developerPrivate.reload(${JSON.stringify(extensionId)}, {
          failQuietly: true, populateErrorForUnpacked: true
        }).then(error => { if (error) throw new Error(error.error || JSON.stringify(error)); return true; })`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      if (response.result?.value !== true) throw new Error('扩展管理页未确认重载成功。');
      try {
        const created = snapshot.tabs.length
          ? await createMissingExtensionPages(cdp, snapshot, await evaluate<ExtensionPages>(`(${captureExtensionPages.toString()})(chrome, ${JSON.stringify(extensionId)})`))
          : { windowIds: {}, createdTargets: [] };
        let restored: Awaited<ReturnType<typeof restoreExtensionPages>> = { windowIds: {}, tabIds: {}, errors: [] };
        if (snapshot.tabs.length) {
          const { targetInfos } = await cdp.send('Target.getTargets');
          const page = targetInfos.find(target => target.type === 'page' && snapshot.tabs.some(tab => tab.url === target.url));
          if (!page) throw new Error('未找到恢复后的扩展页面');
          restored = await evaluateTarget(cdp, page.targetId,
            `(${restoreExtensionPages.toString()})(chrome, ${JSON.stringify(snapshot)}, ${JSON.stringify(created.windowIds)})`,
            false, `chrome-extension://${extensionId}`);
        }
        if (!restored.errors.length) await closeUnusedCreatedPages(cdp, created.createdTargets, restored.tabIds);
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
