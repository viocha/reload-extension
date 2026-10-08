param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('chrome', 'msedge')]
    [string]$Browser
)

$ErrorActionPreference = 'Stop'
$sessionId = if ($Browser -eq 'msedge') { 'e10ad' } else { 'c10ad' }
. (Join-Path $PSScriptRoot 'package-runtime.ps1')
. (Join-Path $PSScriptRoot 'daemon-state.ps1')
$wrapper = Join-Path $PSScriptRoot 'browser-cli-wrapper.ps1'
$connected = $false
$stopped = $false
$sessionLock = Enter-DevToolsSessionLock
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $cliArgs = @($line | ConvertFrom-Json)
            $command = $cliArgs[0]
            if ($command -notin @('list_extensions', 'reload_extension', 'stop')) {
                throw "不支持的会话命令：$command"
            }
            $LASTEXITCODE = 0
            $output = @(& {
                if ($command -eq 'stop') {
                    Repair-DevToolsDaemonState
                    Invoke-ChromeDevToolsCli stop "--sessionId=$sessionId"
                } elseif (-not $connected) {
                    & $wrapper -Browser $Browser @cliArgs
                } else {
                    Invoke-ChromeDevToolsCli @cliArgs "--sessionId=$sessionId"
                }
            } *>&1)
            if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
            $text = $output -join "`n"
            # 底层 CLI 可能将工具错误作为文本返回，但退出码为 0。
            if ($text -match '(?m)^Error:' -or ($command -eq 'reload_extension' -and $text -notmatch '(?m)^Extension reloaded\.\s*$')) {
                throw "DevTools 命令失败：$command`n$text"
            }
            if ($command -eq 'stop') { $stopped = $true } else { $connected = $true }
            $result = @{ stdout = $text; stderr = '' }
        } catch {
            $result = @{ error = $_.Exception.Message }
        }
        [Console]::WriteLine('RELOAD_EXTENSION_RESULT=' + ($result | ConvertTo-Json -Compress))
        if ($stopped) { break }
    }
} finally {
    try {
        # 调用方退出或命令失败时也清理当前会话。
        if (-not $stopped) {
            Repair-DevToolsDaemonState
            Invoke-ChromeDevToolsCli stop "--sessionId=$sessionId" | Out-Null
        }
    } finally {
        $sessionLock.ReleaseMutex()
        $sessionLock.Dispose()
    }
}
