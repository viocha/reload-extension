import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function replaceRequired(source: string, pattern: RegExp, replacement: string): string {
  if (!pattern.test(source)) throw new Error('skills 脚本结构不符合预期，未同步文件');
  return source.replace(pattern, () => replacement);
}
export function adaptConnector(source: string): string {
  let result = source.replace(/\r\n/g, '\n');
  result = replaceRequired(result, /\$skillRoot = Get-Item[^]*?\. \(Join-Path \$skillsRoot 'shared\\chromium-connect\.ps1'\)/,
    ". (Join-Path $PSScriptRoot 'chromium-connect.ps1')\n. (Join-Path $PSScriptRoot 'package-runtime.ps1')");
  result = replaceRequired(result, /\$cli = Get-Command playwright-cli -ErrorAction Stop[^]*?\n\}/,
    '# CLI 与 core 入口由 package-runtime.ps1 从项目依赖解析。');
  result = replaceRequired(result, /Join-Path \$cliDir 'node_modules\\@playwright\\cli\\node_modules\\playwright-core\\lib\\tools\\cli-client\\program\.js'/,
    "Join-Path $playwrightCoreRoot 'lib/tools/cli-client/program.js'");
  result = replaceRequired(result, /Join-Path \$cliDir 'node_modules\\@playwright\\cli\\node_modules\\playwright-core\\lib\\coreBundle\.js'/,
    "Join-Path $playwrightCoreRoot 'lib/coreBundle.js'");
  return result.replace(/\bplaywright-cli(?= "-s=)/g, 'Invoke-PlaywrightCli');
}
export function adaptSessionState(source: string): string {
  return replaceRequired(source.replace(/\r\n/g, '\n'),
    /\$packageRoot = Join-Path \(Split-Path -Parent \$CliSource\) '[^']+'/,
    '$packageRoot = $playwrightCoreRoot');
}
export async function syncPlaywright(skillsRoot: string, targetRoot = projectRoot): Promise<void> {
  const root = path.resolve(targetRoot, skillsRoot);
  const scripts = path.join(root, 'playwright-cli-connect', 'scripts');
  const [shared, connector, state] = await Promise.all([
    readFile(path.join(root, 'shared', 'chromium-connect.ps1'), 'utf8'),
    readFile(path.join(scripts, 'connect-playwright-session.ps1'), 'utf8'),
    readFile(path.join(scripts, 'session-state.ps1'), 'utf8'),
  ]);
  const files = {
    'chromium-connect.ps1': shared,
    'connect-playwright-session.ps1': adaptConnector(connector),
    'session-state.ps1': adaptSessionState(state),
  };
  const target = path.join(targetRoot, 'scripts', 'playwright');
  await mkdir(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(target, name), content);
}
if (import.meta.main) {
  const root = process.env.SKILLS_REPO_DIR?.trim();
  if (root) { await syncPlaywright(root); console.log('已从 skills 同步 Playwright 连接脚本'); }
  else console.log('未配置 SKILLS_REPO_DIR，使用仓库内的连接脚本快照');
}
