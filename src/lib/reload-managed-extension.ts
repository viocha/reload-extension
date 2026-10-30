/** 在扩展管理页执行，禁用扩展以安装完成事件确认重载；不能引用外部运行时变量。 */
export async function reloadManagedExtension(api: any, extensionId: string, disabled: boolean): Promise<boolean> {
  const options = { failQuietly: true, populateErrorForUnpacked: true };
  const loadError = (error: any) => new Error(error.error || JSON.stringify(error));
  if (!disabled) {
    const error = await api.reload(extensionId, options);
    if (error) throw loadError(error);
    return true;
  }
  // 禁用扩展不会触发 OnExtensionLoaded，reload 的 Promise 可能一直挂起。
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      api.onItemStateChanged.removeListener(listener);
      if (error) reject(error);
      else resolve(true);
    };
    const listener = (event: any) => {
      if (event.item_id === extensionId && event.event_type === 'INSTALLED') finish();
    };
    // 先监听再发起重载，避免遗漏同步到达的完成事件。
    api.onItemStateChanged.addListener(listener);
    try {
      api.reload(extensionId, options).then((error: any) => finish(error ? loadError(error) : undefined), finish);
    } catch (error) {
      finish(error);
    }
  });
}
