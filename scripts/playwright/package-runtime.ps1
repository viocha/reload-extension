if ($cliEntry -and $playwrightCoreRoot -and (Test-Path -LiteralPath $cliEntry)) { return }
$node = Get-Command node.exe -ErrorAction Stop
$packageRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
# 由 Node 模块解析器定位实际依赖，兼容 npm 安装与 Bun 链接布局。
$resolveCode = 'const {createRequire}=require("node:module");const path=require("node:path");const r=createRequire(path.join(process.argv[1],"package.json"));const cli=r.resolve("@playwright/cli/package.json");const core=createRequire(cli).resolve("playwright-core/package.json");console.log(JSON.stringify({cli:path.dirname(cli),core:path.dirname(core)}))'
$resolved = & $node.Source -e $resolveCode $packageRoot
if ($LASTEXITCODE -ne 0) { throw '未找到项目依赖 @playwright/cli，请先安装依赖。' }
$paths = $resolved | ConvertFrom-Json
$cliEntry = Join-Path $paths.cli 'playwright-cli.js'
$playwrightCoreRoot = $paths.core
$cli = @{ Source = $cliEntry }

function Invoke-PlaywrightCli {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $output = @(& $node.Source $cliEntry @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Playwright CLI 执行失败：$($output -join "`n")" }
    $output | Write-Output
}
