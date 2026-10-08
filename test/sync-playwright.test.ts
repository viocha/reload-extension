import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptConnector, adaptSessionState, syncPlaywright } from '../scripts/sync-playwright';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const connector = String.raw`$skillRoot = Get-Item -LiteralPath (Split-Path $PSScriptRoot -Parent) -Force
$skillsRoot = Split-Path $skillRoot -Parent
. (Join-Path $skillsRoot 'shared\chromium-connect.ps1')
$cli = Get-Command playwright-cli -ErrorAction Stop
$node = Get-Command node.exe -ErrorAction Stop
$cliEntry = 'global'
if (-not (Test-Path $cliEntry)) {
    throw '找不到 CLI'
}
$programFile = Join-Path $cliDir 'node_modules\@playwright\cli\node_modules\playwright-core\lib\tools\cli-client\program.js'
$coreBundle = Join-Path $cliDir 'node_modules\@playwright\cli\node_modules\playwright-core\lib\coreBundle.js'
playwright-cli "-s=$Session" detach
`;
const state = String.raw`$packageRoot = Join-Path (Split-Path -Parent $CliSource) 'node_modules\@playwright\cli\node_modules\playwright-core'`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reload-sync-test-')); roots.push(root);
  const scripts = path.join(root, 'skills/playwright-cli-connect/scripts');
  await mkdir(scripts, { recursive: true }); await mkdir(path.join(root, 'skills/shared'), { recursive: true });
  await writeFile(path.join(root, 'skills/shared/chromium-connect.ps1'), '共享脚本快照');
  await writeFile(path.join(scripts, 'connect-playwright-session.ps1'), connector);
  await writeFile(path.join(scripts, 'session-state.ps1'), state);
  return root;
}
test('连接器与 session 计算使用包内依赖的实际路径', () => {
  const adapted = adaptConnector(connector);
  expect(adapted).toContain(". (Join-Path $PSScriptRoot 'package-runtime.ps1')");
  expect(adapted).toContain("Join-Path $playwrightCoreRoot 'lib/coreBundle.js'");
  expect(adapted).toContain("Join-Path $playwrightCoreRoot 'lib/tools/cli-client/program.js'");
  expect(adapted).toContain('Invoke-PlaywrightCli "-s=$Session" detach');
  expect(adaptSessionState(state)).toBe('$packageRoot = $playwrightCoreRoot');
});
test('相对目录同步共享、连接和 session 脚本', async () => {
  const root = await fixture(); await syncPlaywright('skills', root);
  expect(await readFile(path.join(root, 'scripts/playwright/chromium-connect.ps1'), 'utf8')).toBe('共享脚本快照');
  expect(await readFile(path.join(root, 'scripts/playwright/connect-playwright-session.ps1'), 'utf8')).toBe(adaptConnector(connector));
  expect(await readFile(path.join(root, 'scripts/playwright/session-state.ps1'), 'utf8')).toBe(adaptSessionState(state));
});
test('源文件缺失或无法适配时保留全部快照', async () => {
  const root = await fixture(); await syncPlaywright('skills', root);
  const target = path.join(root, 'scripts/playwright');
  const names = ['chromium-connect.ps1', 'connect-playwright-session.ps1', 'session-state.ps1'];
  const snapshots = await Promise.all(names.map(name => readFile(path.join(target, name), 'utf8')));
  const source = path.join(root, 'skills/playwright-cli-connect/scripts/session-state.ps1');
  await writeFile(source, '结构变化');
  await expect(syncPlaywright('skills', root)).rejects.toThrow('结构不符合预期');
  await rm(source);
  await expect(syncPlaywright('skills', root)).rejects.toThrow('ENOENT');
  expect(await Promise.all(names.map(name => readFile(path.join(target, name), 'utf8')))).toEqual(snapshots);
});
