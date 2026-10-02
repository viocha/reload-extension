import { runDevTools } from './lib/devtools.js';
import { findExtension, parseExtensions } from './lib/extensions.js';
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
  try {
    return await readExtensions(browser);
  } finally {
    await runDevTools(browser, ['stop']);
  }
}

export async function reloadExtension(
  options: ReloadExtensionOptions,
): Promise<BrowserExtension | { id: string; name: string }> {
  if (!options || (!options.name && !options.id)) {
    throw new TypeError('需要提供扩展名称 name 或扩展 ID id');
  }

  const browser = normalizeBrowser(options.browser);
  try {
    let extension: BrowserExtension | { id: string; name: string };

    if (options.id) {
      extension = { id: options.id, name: options.name ?? options.id };
    } else {
      const extensions = await readExtensions(browser);
      extension = findExtension(extensions, options.name!);
    }

    await runDevTools(browser, ['reload_extension', extension.id]);
    return extension;
  } finally {
    await runDevTools(browser, ['stop']);
  }
}

async function readExtensions(browser: 'edge' | 'chrome'): Promise<BrowserExtension[]> {
  const result = await runDevTools(browser, ['list_extensions']);
  return parseExtensions(result.stdout);
}

function normalizeBrowser(browser: BrowserName = 'edge'): 'edge' | 'chrome' {
  const value = browser.toLowerCase();
  if (value === 'edge' || value === 'msedge') return 'edge';
  if (value === 'chrome') return 'chrome';
  throw new TypeError(`不支持的浏览器: ${browser}，仅支持 edge 或 chrome`);
}
