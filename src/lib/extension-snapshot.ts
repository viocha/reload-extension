import type { CDPSession } from 'playwright-core';
import { captureExtensionPages, type ExtensionPages } from './extension-pages.js';
import { evaluateTarget } from './target-evaluate.js';

/** tabs/windows 只在扩展自身上下文调用，Chrome 的管理页不提供这些 API。 */
export async function withExtensionPage<T>(cdp: CDPSession, extensionId: string, operation: (targetId: string) => Promise<T>, createHelper = false): Promise<T | undefined> {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const origin = `chrome-extension://${extensionId}`;
  const page = targetInfos.find(target => ['page', 'background_page'].includes(target.type) && target.url.startsWith(origin + '/'));
  let targetId = page?.targetId;
  let helper: string | undefined;
  if (!targetId && createHelper) {
    ({ targetId } = await cdp.send('Target.createTarget', { url: origin + '/manifest.json', hidden: true }));
    helper = targetId;
  }
  if (!targetId) return undefined;
  try {
    return await operation(targetId);
  } finally {
    if (helper) await cdp.send('Target.closeTarget', { targetId: helper });
  }
}

export async function evaluateExtensionPage<T>(cdp: CDPSession, extensionId: string, expression: string, createHelper = false): Promise<T | undefined> {
  return withExtensionPage(cdp, extensionId, targetId => evaluateTarget<T>(cdp, targetId, expression, false, `chrome-extension://${extensionId}`), createHelper);
}

export async function captureExtensionSnapshot(cdp: CDPSession, extensionId: string, sidePanelUrls: string[] = [], createHelper = false, trackedTabIds: number[] = []): Promise<ExtensionPages> {
  return await evaluateExtensionPage<ExtensionPages>(cdp, extensionId,
    `(${captureExtensionPages.toString()})(chrome, ${JSON.stringify(extensionId)}, ${JSON.stringify(sidePanelUrls)}, ${JSON.stringify(trackedTabIds)})`, createHelper)
    ?? { tabs: [], windows: [], sidePanelUrls };
}
