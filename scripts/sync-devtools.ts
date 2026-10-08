import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source: string, pattern: RegExp, replacement: string, label: string): string {
  if (!pattern.test(source)) throw new Error(`skills 脚本结构不符合预期：${label}，未同步文件`);
  return source.replace(pattern, () => replacement);
}

export function adaptConnectionScript(source: string, connector: boolean): string {
  let result = source.replace(/\r\n/g, '\n');
  result = replaceRequired(result,
    /\$skillRoot = Get-Item[^]*?\. \(Join-Path \$skillsRoot 'shared\\chromium-connect\.ps1'\)/,
    ". (Join-Path $PSScriptRoot 'chromium-connect.ps1')\n. (Join-Path $PSScriptRoot 'package-runtime.ps1')",
    '共享脚本路径');
  result = replaceRequired(result,
    /\{ 'ed9e' \} else \{ 'c4700e' \}/,
    "{ 'e10ad' } else { 'c10ad' }", '独立 session');
  result = result.replace(/^(\s*)chrome-devtools(?=\s)/gm, '$1Invoke-ChromeDevToolsCli');

  if (connector) {
    result = replaceRequired(result,
      /\$cli = Get-Command chrome-devtools -ErrorAction Stop\n\$node = Get-Command node\.exe -ErrorAction Stop\n\$cliEntry =[^]*?\n\}/,
      '# CLI 入口由 package-runtime.ps1 从项目依赖解析。', 'CLI 入口');
    result = replaceRequired(result,
      /    \$npm = Get-Command npm\.cmd[^]*?        \$browserFile = Join-Path \$npmRoot 'chrome-devtools-mcp\\build\\src\\BrowserManager\.js'/,
      "    try {\n        $browserFile = Join-Path $chromeDevToolsPackageRoot 'build\\src\\BrowserManager.js'",
      'Edge 兼容补丁依赖路径');
  }
  return result;
}

export function adaptDaemonStateScript(source: string): string {
  return replaceRequired(source.replace(/\r\n/g, '\n'),
    /    \$entry = Join-Path \(Split-Path \(Get-Command chrome-devtools\)\.Source -Parent\) 'node_modules\/chrome-devtools-mcp\/build\/src\/daemon\/daemon\.js'/,
    "    $entry = Join-Path $chromeDevToolsPackageRoot 'build/src/daemon/daemon.js'",
    'daemon 进程身份依赖路径');
}

export async function syncDevTools(skillsRoot: string, targetRoot = projectRoot): Promise<void> {
  const sourceRoot = path.resolve(targetRoot, skillsRoot);
  const sourceScripts = path.join(sourceRoot, 'chrome-devtools-cli-connect', 'scripts');
  // 全部读取和适配成功后再写入，缺失文件或源脚本变化时保留已有快照。
  const [shared, wrapper, connector, daemon, edge, chrome] = await Promise.all([
    readFile(path.join(sourceRoot, 'shared', 'chromium-connect.ps1'), 'utf8'),
    readFile(path.join(sourceScripts, 'browser-cli-wrapper.ps1'), 'utf8'),
    readFile(path.join(sourceScripts, 'connect-devtools-session.ps1'), 'utf8'),
    readFile(path.join(sourceScripts, 'daemon-state.ps1'), 'utf8'),
    readFile(path.join(sourceRoot, 'chrome-devtools-cli-connect', 'chrome-devtools-edge.ps1'), 'utf8'),
    readFile(path.join(sourceRoot, 'chrome-devtools-cli-connect', 'chrome-devtools-chrome.ps1'), 'utf8'),
  ]);
  const files = {
    'chromium-connect.ps1': shared,
    'browser-cli-wrapper.ps1': adaptConnectionScript(wrapper, false),
    'connect-devtools-session.ps1': adaptConnectionScript(connector, true),
    'daemon-state.ps1': adaptDaemonStateScript(daemon),
    'chrome-devtools-edge.ps1': replaceRequired(edge, /\$PSScriptRoot\/scripts\/browser-cli-wrapper\.ps1/, '$PSScriptRoot/browser-cli-wrapper.ps1', 'Edge wrapper 路径'),
    'chrome-devtools-chrome.ps1': replaceRequired(chrome, /\$PSScriptRoot\/scripts\/browser-cli-wrapper\.ps1/, '$PSScriptRoot/browser-cli-wrapper.ps1', 'Chrome wrapper 路径'),
  };
  const targetDir = path.join(targetRoot, 'scripts', 'devtools');
  await mkdir(targetDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(targetDir, name), content, 'utf8');
  }
}

if (import.meta.main) {
  const skillsRoot = process.env.SKILLS_REPO_DIR?.trim();
  if (skillsRoot) {
    await syncDevTools(skillsRoot);
    console.log('已从 skills 同步浏览器连接脚本');
  } else {
    console.log('未配置 SKILLS_REPO_DIR，使用仓库内的连接脚本快照');
  }
}
