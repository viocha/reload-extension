param([Parameter(Mandatory = $true)][ValidateSet('chrome', 'msedge')][string]$Browser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'chromium-connect.ps1')
Initialize-ChromiumRemoteDebuggingAuthorization -Browser $Browser
$packageRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Get-Command node.exe -ErrorAction Stop).Source
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.Arguments = '"' + (Join-Path $packageRoot 'dist/browser-worker.js') + '" ' + $Browser
$worker = [Diagnostics.Process]::Start($info)
$errors = $worker.StandardError.ReadToEndAsync()
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        $worker.StandardInput.WriteLine($line)
        $response = $worker.StandardOutput.ReadLineAsync()
        $result = Wait-ChromiumCompletionWithAuthorization -WaitSeconds 10 `
            -IsCompleted { $response.IsCompleted -or $worker.HasExited } `
            -WaitForCompletion { [void]$response.Wait(100) }
        if ($result.TimedOut) { throw '浏览器操作在 10 秒内未完成。' }
        $value = $response.GetAwaiter().GetResult()
        if ($null -eq $value) { throw "浏览器进程未返回结果：$($errors.GetAwaiter().GetResult())" }
        [Console]::WriteLine($value)
        $request = @($line | ConvertFrom-Json)
        if ($request[0] -eq 'stop') {
            if (-not $worker.WaitForExit(1000)) { throw '浏览器连接清理超时。' }
            break
        }
    }
} finally {
    if (-not $worker.HasExited) { Stop-ChromiumProcessTree -Process $worker }
    $worker.Dispose()
    Restore-ChromiumMinimizedWindows
}
