import type { CDPSession } from 'playwright-core';
import { captureExtensionPages, type ExtensionPages } from './extension-pages.js';
import { evaluateTarget } from './target-evaluate.js';

/** tabs/windows 只在扩展自身上下文调用，Chrome 的管理页不提供这些 API。 */
export async function captureExtensionSnapshot(cdp: CDPSession, extensionId: string, sidePanelUrls: string[] = [], fallbackUrl?: string): Promise<ExtensionPages> {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const origin = `chrome-extension://${extensionId}`;
  const page = targetInfos.find(target => ['page', 'background_page'].includes(target.type) && target.url.startsWith(origin + '/'));
  let targetId = page?.targetId;
  let helper: string | undefined;
  if (!targetId && fallbackUrl) {
    ({ targetId } = await cdp.send('Target.createTarget', { url: fallbackUrl, hidden: true }));
    helper = targetId;
  }
  if (!targetId) return { tabs: [], windows: [], sidePanelUrls };
  try {
    return await evaluateTarget(cdp, targetId,
      `(${captureExtensionPages.toString()})(chrome, ${JSON.stringify(extensionId)}, ${JSON.stringify(sidePanelUrls)})`, false, origin);
  } finally {
    if (helper) await cdp.send('Target.closeTarget', { targetId: helper });
  }
}
