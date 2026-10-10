param([Parameter(Mandatory = $true)][ValidateSet('chrome', 'msedge')][string]$Browser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-runtime.ps1')
$session = if ($Browser -eq 'msedge') { 'reload-extension-edge' } else { 'reload-extension-chrome' }
$mutex = [Threading.Mutex]::new($false, "Local\$session")
$locked = $false
$connected = $false
$temporaryTab = $false
$stopped = $false
$settle = $env:PLAYWRIGHT_MCP_TIMEOUT_SETTLE
function Invoke-SessionCommand {
    param([string[]]$CommandArgs)
    & (Join-Path $PSScriptRoot 'connect-playwright-session.ps1') -Browser $Browser -Session $session -ReuseSession -TimeoutSeconds 10 -CommandTimeoutSeconds 10 -CommandArgs $CommandArgs
}
function Close-Session {
    try {
        if ($temporaryTab) {
            Invoke-SessionCommand -CommandArgs @('tab-close') | Out-Null
            $script:temporaryTab = $false
        }
    } finally {
        Invoke-SessionCommand -CommandArgs @('detach') | Out-Null
    }
}
try {
    try { $locked = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '等待扩展重载会话超时' }
    # 扩展操作等待 CDP 的完成响应，不涉及页面交互，无需页面稳定延迟。
    $env:PLAYWRIGHT_MCP_TIMEOUT_SETTLE = '0'
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $arguments = @($line | ConvertFrom-Json)
            if ($arguments[0] -eq 'stop') {
                Close-Session
                $stopped = $true
                $result = @{ stdout = ''; stderr = '' }
            } elseif ($arguments[0] -eq 'run' -and $arguments.Count -eq 2) {
                $command = @('--raw', 'run-code', $arguments[1])
                $output = @(& {
                    if (-not $connected) {
                        # run-code 会等待当前页初始化；使用本会话独占的空白页。
                        Invoke-SessionCommand -CommandArgs @('tab-new', 'about:blank') | Out-Null
                        $script:temporaryTab = $true
                        $script:connected = $true
                    }
                    Invoke-SessionCommand -CommandArgs $command
                } *>&1)
                $connected = $true
                $json = (($output -join "`n") -split "`n" | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
                if (-not $json) { throw "Playwright 未返回操作结果：$($output -join "`n")" }
                $payload = $json | ConvertFrom-Json
                if ($payload.error) { throw $payload.error }
                $result = @{ stdout = $json; stderr = '' }
            } else { throw '不支持的会话命令' }
        } catch { $result = @{ error = $_.Exception.Message } }
        [Console]::WriteLine('RELOAD_EXTENSION_RESULT=' + ($result | ConvertTo-Json -Compress))
        if ($stopped) { break }
    }
} finally {
    try {
        if ($locked -and -not $stopped) { Close-Session }
    } finally {
        $env:PLAYWRIGHT_MCP_TIMEOUT_SETTLE = $settle
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
