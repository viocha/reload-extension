#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { listExtensions, reloadExtension } from './index.js';
import type { BrowserName } from './types.js';

interface CliOptions {
  browser: BrowserName;
  id?: string;
  list?: boolean;
}

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('reload-extension')
  .description('按名称重新加载当前 Chrome/Edge 中的 unpacked 扩展')
  .version(packageJson.version, '-v, --version')
  .argument('[name]', '扩展名称')
  .option('-b, --browser <browser>', '目标浏览器', parseBrowser, 'edge')
  .option('--id <extension-id>', '直接按扩展 ID 重新加载')
  .option('--list', '列出已安装扩展')
  .addHelpText(
    'after',
    `
示例:
  $ reload-extension "Web Toolkit"
  $ reload-extension "Web Toolkit" --browser chrome
  $ reload-extension --id ncekidoiekbflbbpoldpfldjnbccfmmm
  $ reload-extension --list
`,
  )
  .action(async (name: string | undefined, options: CliOptions) => {
    if (options.list) {
      const extensions = await listExtensions({ browser: options.browser });
      for (const extension of extensions) {
        console.log(
          `${extension.enabled ? 'enabled ' : 'disabled'} ${extension.id} ${extension.name} v${extension.version}`,
        );
      }
      return;
    }

    if (!name && !options.id) {
      throw new InvalidArgumentError('需要提供扩展名称，或使用 --id <extension-id>');
    }

    const extension = await reloadExtension({
      name,
      id: options.id,
      browser: options.browser,
    });
    const browser = options.browser === 'msedge' ? 'edge' : options.browser;
    console.log(`Reloaded "${extension.name}" (${extension.id}) in ${browser}.`);
  });

await program.parseAsync(process.argv).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseBrowser(value: string): BrowserName {
  const browser = value.toLowerCase();
  if (browser === 'edge' || browser === 'msedge' || browser === 'chrome') {
    return browser;
  }
  throw new InvalidArgumentError('仅支持 edge、msedge 或 chrome');
}
