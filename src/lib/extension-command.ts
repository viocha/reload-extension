import type { Browser } from 'playwright-core';
import { reloadFromExtensionManager } from './extension-manager.js';

/** 查询使用浏览器级 CDP，重载使用隐藏的扩展管理页。 */
export async function executeExtensionCommand(browser: Pick<Browser, 'newBrowserCDPSession'>, args: string[]): Promise<object> {
  if (args[0] !== 'list_extensions' && args[0] !== 'reload_extension') throw new Error('不支持的扩展命令');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { extensions } = await cdp.send('Extensions.getExtensions');
    if (args[0] === 'list_extensions') return { extensions };
    const extension = extensions.find(item => item.id === args[1]);
    if (!extension) throw new Error('Extension with ID ' + args[1] + ' not found.');
    if (!extension.path) throw new Error('扩展缺少 unpacked 路径：' + extension.name);
    await reloadFromExtensionManager(cdp, extension.id);
    return { reloaded: true };
  } finally {
    await cdp.detach();
  }
}
