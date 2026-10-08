function Resolve-ChromeDevToolsPackageRoot {
    param([Parameter(Mandatory = $true)][string]$StartPath)

    if ($env:RELOAD_EXTENSION_CHROME_DEVTOOLS_ROOT -and (Test-Path -LiteralPath $env:RELOAD_EXTENSION_CHROME_DEVTOOLS_ROOT)) {
        return $env:RELOAD_EXTENSION_CHROME_DEVTOOLS_ROOT
    }

    $current = [IO.Path]::GetFullPath($StartPath)
    while ($current) {
        $candidate = Join-Path $current 'node_modules\chrome-devtools-mcp'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
    throw "未找到项目依赖 chrome-devtools-mcp，起始目录：$StartPath"
}

$packageRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$chromeDevToolsPackageRoot = Resolve-ChromeDevToolsPackageRoot -StartPath $packageRoot
$cliEntry = Join-Path $chromeDevToolsPackageRoot 'build\src\bin\chrome-devtools.js'
$node = Get-Command node.exe -ErrorAction Stop
if (-not (Test-Path -LiteralPath $cliEntry)) {
    throw "未找到项目依赖 chrome-devtools-mcp CLI：$cliEntry"
}

function Invoke-ChromeDevToolsCli {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $output = @(& $node.Source $cliEntry @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $output | Write-Output
    if ($exitCode -ne 0) {
        throw "Chrome DevTools CLI 执行失败，退出码 $exitCode`n$($output -join "`n")"
    }
}
