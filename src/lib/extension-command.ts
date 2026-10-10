import type { Browser } from 'playwright-core';

/** 仅使用浏览器级 CDP，不读取、创建或激活任何页面。 */
export async function executeExtensionCommand(browser: Pick<Browser, 'newBrowserCDPSession'>, args: string[]): Promise<object> {
  if (args[0] !== 'list_extensions' && args[0] !== 'reload_extension') throw new Error('不支持的扩展命令');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { extensions } = await cdp.send('Extensions.getExtensions');
    if (args[0] === 'list_extensions') return { extensions };
    const extension = extensions.find(item => item.id === args[1]);
    if (!extension) throw new Error('Extension with ID ' + args[1] + ' not found.');
    if (!extension.path) throw new Error('扩展缺少 unpacked 路径：' + extension.name);
    const result = await cdp.send('Extensions.loadUnpacked', { path: extension.path });
    if (result.id !== extension.id) throw new Error('重载返回的扩展 ID 不匹配');
    return { reloaded: true };
  } finally {
    await cdp.detach();
  }
}
