import type { BrowserExtension } from '../types.js';

const EXTENSION_LINE = /^id=([a-p]{32})\s+"(.*)"\s+v(\S+)\s+(Enabled|Disabled)$/;

export function parseExtensions(output: string): BrowserExtension[] {
  const extensions: BrowserExtension[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = EXTENSION_LINE.exec(line);
    if (!match) continue;

    extensions.push({
      id: match[1],
      name: match[2],
      version: match[3],
      enabled: match[4] === 'Enabled',
    });
  }

  return extensions;
}

export function findExtension(
  extensions: BrowserExtension[],
  name: string,
): BrowserExtension {
  const query = name.trim();
  if (!query) throw new TypeError('扩展名称不能为空');

  const exact = extensions.filter(
    extension =>
      extension.name.localeCompare(query, undefined, { sensitivity: 'accent' }) === 0,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`找到多个同名扩展: ${query}`);

  const lowerQuery = query.toLocaleLowerCase();
  const partial = extensions.filter(extension =>
    extension.name.toLocaleLowerCase().includes(lowerQuery),
  );

  if (partial.length === 1) return partial[0];
  if (partial.length === 0) throw new Error(`未找到扩展: ${query}`);

  throw new Error(
    `扩展名称不唯一: ${query}\n${partial
      .map(extension => `  - ${extension.name} (${extension.id})`)
      .join('\n')}`,
  );
}
