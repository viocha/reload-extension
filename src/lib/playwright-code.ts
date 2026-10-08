/** run-code 在 Playwright 进程执行，扩展操作通过浏览器级 CDP 完成。 */
export function createExtensionScript(args: string[]): string {
  if (args[0] !== 'list_extensions' && args[0] !== 'reload_extension') throw new Error('不支持的扩展命令');
  return `async page => {
    const args = ${JSON.stringify(args)};
    const cdp = await page.context().browser().newBrowserCDPSession();
    try {
      const { extensions } = await cdp.send('Extensions.getExtensions');
      if (args[0] === 'list_extensions') return { extensions };
      const extension = extensions.find(item => item.id === args[1]);
      if (!extension) throw new Error('Extension with ID ' + args[1] + ' not found.');
      if (!extension.path) throw new Error('扩展缺少 unpacked 路径：' + extension.name);
      const result = await cdp.send('Extensions.loadUnpacked', { path: extension.path });
      if (result.id !== extension.id) throw new Error('重载返回的扩展 ID 不匹配');
      return { reloaded: true };
    } catch (error) { return { error: error.message }; }
    finally { await cdp.detach(); }
  }`;
}
