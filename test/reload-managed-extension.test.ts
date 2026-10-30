import { expect, test } from 'bun:test';
import { reloadManagedExtension } from '../src/lib/reload-managed-extension';

// 验证实际注入管理页的函数文本可以独立执行。
const reload = new Function(`return (${reloadManagedExtension.toString()})`)() as typeof reloadManagedExtension;
const extensionId = 'disabled-extension';
function events() {
  const listeners = new Set<(event: any) => void>();
  return {
    listeners,
    addListener: (listener: (event: any) => void) => { listeners.add(listener); },
    removeListener: (listener: (event: any) => void) => { listeners.delete(listener); },
    emit: (event: any) => { for (const listener of listeners) listener(event); },
  };
}

test('禁用扩展的重载 Promise 挂起时，安装完成事件立即确认成功并清理监听', async () => {
  const onItemStateChanged = events();
  const result = await reload({
    onItemStateChanged,
    reload: (id: string, options: object) => {
      expect(id).toBe(extensionId);
      expect(options).toEqual({ failQuietly: true, populateErrorForUnpacked: true });
      expect(onItemStateChanged.listeners.size).toBe(1);
      // 同步触发，覆盖浏览器响应极快时的监听顺序。
      onItemStateChanged.emit({ item_id: id, event_type: 'INSTALLED', extensionInfo: { state: 'DISABLED' } });
      return new Promise(() => {});
    },
  }, extensionId, true);
  expect(result).toBe(true);
  expect(onItemStateChanged.listeners.size).toBe(0);
});

test('其他扩展及非安装事件不能提前确认重载完成', async () => {
  const onItemStateChanged = events();
  let completed = false;
  const result = reload({ onItemStateChanged, reload: () => new Promise(() => {}) }, extensionId, true)
    .then(value => { completed = true; return value; });
  onItemStateChanged.emit({ item_id: 'other', event_type: 'INSTALLED' });
  onItemStateChanged.emit({ item_id: extensionId, event_type: 'UNLOADED' });
  onItemStateChanged.emit({ item_id: extensionId, event_type: 'PERMISSIONS_CHANGED' });
  await Promise.resolve();
  expect(completed).toBe(false);
  onItemStateChanged.emit({ item_id: extensionId, event_type: 'INSTALLED' });
  expect(await result).toBe(true);
  expect(onItemStateChanged.listeners.size).toBe(0);
});

test('禁用扩展加载失败时报告浏览器错误并清理监听', async () => {
  for (const [message, fail] of [
    ['manifest 无效', async () => ({ error: 'manifest 无效' })],
    ['权限错误', async () => { throw new Error('权限错误'); }],
    ['接口调用失败', () => { throw new Error('接口调用失败'); }],
  ] as const) {
    const onItemStateChanged = events();
    await expect(reload({ onItemStateChanged, reload: fail }, extensionId, true)).rejects.toThrow(message);
    expect(onItemStateChanged.listeners.size).toBe(0);
  }
});

test('浏览器直接确认禁用扩展重载时也清理监听', async () => {
  const onItemStateChanged = events();
  expect(await reload({ onItemStateChanged, reload: async () => undefined }, extensionId, true)).toBe(true);
  expect(onItemStateChanged.listeners.size).toBe(0);
});

test('已启用扩展等待加载确认，不依赖安装完成事件', async () => {
  const completed = Promise.withResolvers<undefined>();
  let settled = false;
  const result = reload({ reload: () => completed.promise }, extensionId, false)
    .then(value => { settled = true; return value; });
  await Promise.resolve();
  expect(settled).toBe(false);
  completed.resolve(undefined);
  expect(await result).toBe(true);
  await expect(reload({ reload: async () => ({ error: '加载失败' }) }, extensionId, false)).rejects.toThrow('加载失败');
});
