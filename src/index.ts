import { withDevToolsSession, type RunDevTools } from './lib/devtools.js';
import { findExtension, parseExtensions } from './lib/extensions.js';
import { extensionCache } from './lib/extension-cache.js';
import type {
  BrowserExtension,
  BrowserName,
  ListExtensionsOptions,
  ReloadExtensionOptions,
} from './types.js';

export type {
  BrowserExtension,
  BrowserName,
  ListExtensionsOptions,
  ReloadExtensionOptions,
} from './types.js';

export async function listExtensions(
  options: ListExtensionsOptions = {},
): Promise<BrowserExtension[]> {
  const browser = normalizeBrowser(options.browser);
  return withDevToolsSession(browser, readExtensions);
}

export async function clearExtensionCache(): Promise<void> {
  await extensionCache.clear();
}

export async function reloadExtension(
  options: ReloadExtensionOptions,
): Promise<BrowserExtension | { id: string; name: string }> {
  if (!options || (!options.name && !options.id)) {
    throw new TypeError('需要提供扩展名称 name 或扩展 ID id');
  }

  const browser = normalizeBrowser(options.browser);
  return withDevToolsSession(browser, async (run) => {
    let extension: BrowserExtension | { id: string; name: string };

    if (options.id) {
      extension = { id: options.id, name: options.name ?? options.id };
    } else {
      const cached = options.cache === false ? undefined : await extensionCache.get(browser, options.name!);
      if (cached) {
        try {
          await run(['reload_extension', cached.id]);
          return cached;
        } catch (error) {
          // 仅 ID 已失效时重新查找，连接和权限等错误直接报告。
          if (!(error instanceof Error) || !error.message.includes(`Extension with ID ${cached.id} not found.`)) throw error;
          await extensionCache.remove(browser, options.name!);
        }
      }
      const extensions = await readExtensions(run);
      extension = findExtension(extensions, options.name!);
    }

    await run(['reload_extension', extension.id]);
    if (!options.id) await extensionCache.set(browser, options.name!, extension);
    return extension;
  });
}

async function readExtensions(run: RunDevTools): Promise<BrowserExtension[]> {
  const result = await run(['list_extensions']);
  return parseExtensions(result.stdout);
}

function normalizeBrowser(browser: BrowserName = 'edge'): 'edge' | 'chrome' {
  const value = browser.toLowerCase();
  if (value === 'edge' || value === 'msedge') return 'edge';
  if (value === 'chrome') return 'chrome';
  throw new TypeError(`不支持的浏览器: ${browser}，仅支持 edge 或 chrome`);
}
