import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptConnectionScript, syncDevTools } from '../scripts/sync-devtools';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const wrapper = `$sessionId = if ($Browser -eq 'msedge') { 'ed9e' } else { 'c4700e' }
$skillRoot = Get-Item -LiteralPath (Split-Path $PSScriptRoot -Parent) -Force
$skillsRoot = Split-Path $skillRoot -Parent
. (Join-Path $skillsRoot 'shared\\chromium-connect.ps1')
chrome-devtools @CliArgs "--sessionId=$sessionId"
`;
const connector = `${wrapper}
$cli = Get-Command chrome-devtools -ErrorAction Stop
$node = Get-Command node.exe -ErrorAction Stop
$cliEntry = Join-Path (Split-Path -Parent $cli.Source) 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools.js'
if (-not (Test-Path -LiteralPath $cliEntry)) {
    throw '找不到 CLI'
}
function Ensure-DormantPageTargetCompatibility {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    try {
        $npmRoot = (& $npm.Source root -g).Trim()
        $browserFile = Join-Path $npmRoot 'chrome-devtools-mcp\\build\\src\\BrowserManager.js'
    } catch { throw }
}
`;

test('同步适配使用项目依赖和独立 session', () => {
  const adapted = adaptConnectionScript(connector, true);
  expect(adapted).toContain("{ 'e10ad' } else { 'c10ad' }");
  expect(adapted).toContain(". (Join-Path $PSScriptRoot 'package-runtime.ps1')");
  expect(adapted).toContain('Invoke-ChromeDevToolsCli @CliArgs');
  expect(adapted).toContain("Join-Path $chromeDevToolsPackageRoot 'build\\src\\BrowserManager.js'");
  expect(adapted).not.toContain('Get-Command chrome-devtools');
  expect(adapted).not.toContain('$npmRoot');
});

test('源脚本结构变化时明确报错', () => {
  expect(() => adaptConnectionScript(wrapper.replace('ed9e', 'changed'), false)).toThrow('独立 session');
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reload-sync-test-'));
  roots.push(root);
  const skill = path.join(root, 'skills', 'chrome-devtools-cli-connect');
  await mkdir(path.join(skill, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'shared'), { recursive: true });
  await writeFile(path.join(root, 'skills', 'shared', 'chromium-connect.ps1'), '共享脚本快照');
  await writeFile(path.join(skill, 'scripts', 'browser-cli-wrapper.ps1'), wrapper);
  await writeFile(path.join(skill, 'scripts', 'connect-devtools-session.ps1'), connector);
  for (const browser of ['edge', 'chrome']) {
    await writeFile(path.join(skill, `chrome-devtools-${browser}.ps1`), '& "$PSScriptRoot/scripts/browser-cli-wrapper.ps1"');
  }
  return root;
}

test('从相对 skills 目录同步全部脚本', async () => {
  const root = await createFixture();
  await syncDevTools('skills', root);
  const output = path.join(root, 'scripts', 'devtools');
  expect(await readFile(path.join(output, 'chromium-connect.ps1'), 'utf8')).toBe('共享脚本快照');
  expect(await readFile(path.join(output, 'chrome-devtools-edge.ps1'), 'utf8')).toBe('& "$PSScriptRoot/browser-cli-wrapper.ps1"');
  expect(await readFile(path.join(output, 'chrome-devtools-chrome.ps1'), 'utf8')).toBe('& "$PSScriptRoot/browser-cli-wrapper.ps1"');
  expect(await readFile(path.join(output, 'connect-devtools-session.ps1'), 'utf8')).toContain('Invoke-ChromeDevToolsCli');
});

test('适配失败时不覆盖已有脚本快照', async () => {
  const root = await createFixture();
  await syncDevTools('skills', root);
  const snapshot = path.join(root, 'scripts', 'devtools', 'chromium-connect.ps1');
  await writeFile(snapshot, '保留的快照');
  await writeFile(path.join(root, 'skills', 'chrome-devtools-cli-connect', 'scripts', 'connect-devtools-session.ps1'), '无法适配');
  await expect(syncDevTools('skills', root)).rejects.toThrow('结构不符合预期');
  expect(await readFile(snapshot, 'utf8')).toBe('保留的快照');
});
