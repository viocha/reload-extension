# 只管理当前 session 的 PID 文件；PID 存活不等于 daemon 存活。
function Enter-DevToolsSessionLock {
    $mutex = [Threading.Mutex]::new($false, "Local\DevTools-$env:USERNAME-$SessionId")
    try {
        try { $acquired = $mutex.WaitOne(30000) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "等待 session $SessionId 操作锁超时。" }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}

function Get-DevToolsDaemonState {
    $runtimeRoot = if ($env:XDG_RUNTIME_DIR) { $env:XDG_RUNTIME_DIR } else { [IO.Path]::GetTempPath() }
    $stateFile = Join-Path $runtimeRoot "chrome-devtools-mcp-$SessionId/daemon.pid"
    $state = [pscustomobject]@{ File = $stateFile; Process = $null; Owned = $false; Pipe = $false; Raw = '' }
    $pipeName = "chrome-devtools-mcp-$SessionId-$env:USERNAME\server.sock"
    $state.Pipe = Test-Path -LiteralPath "\\.\pipe\$pipeName" -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $stateFile) { $state.Raw = [IO.File]::ReadAllText($stateFile).Trim() }
    $daemonId = 0
    [void][int]::TryParse($state.Raw, [ref]$daemonId)
    if ($state.Pipe) {
        if (-not ('DevToolsPipeOwner' -as [type])) {
            Add-Type @'
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DevToolsPipeOwner {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint id);
}
'@
        }
        $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(500)
            $ownerId = [uint32]0
            if (-not [DevToolsPipeOwner]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$ownerId)) {
                throw '无法核对 named pipe 所属进程。'
            }
            $daemonId = [int]$ownerId
        } finally { $pipe.Dispose() }
    }
    if ($daemonId -le 0) { return $state }
    $state.Process = Get-CimInstance Win32_Process -Filter "ProcessId=$daemonId"
    if (-not $state.Process) { return $state }
    $entry = Join-Path $chromeDevToolsPackageRoot 'build/src/daemon/daemon.js'
    $command = $state.Process.CommandLine
    $identityMatches = $command -and $command.Replace('\', '/').Contains($entry.Replace('\', '/'))
    # 文件写入应发生在进程创建之后，防止复用的工具进程被误杀。
    $state.Owned = $identityMatches -and ($state.Pipe -or ($state.Process.CreationDate -le (Get-Item -LiteralPath $stateFile).LastWriteTime))
    return $state
}

function Repair-DevToolsDaemonState([switch]$Reset) {
    $state = Get-DevToolsDaemonState
    if ($state.Owned -and $state.Pipe -and $state.Raw -eq [string]$state.Process.ProcessId -and -not $Reset) { return }
    if (-not $state.Owned -and -not (Test-Path -LiteralPath $state.File)) { return }
    if ($state.Owned) {
        # 再次检查创建时间，避免检查和终止之间发生 PID 复用。
        $target = Get-Process -Id $state.Process.ProcessId -ErrorAction SilentlyContinue
        if ($target -and [Math]::Abs(($target.StartTime - $state.Process.CreationDate).TotalMilliseconds) -lt 1) {
            Write-Host "DEVTOOLS_DAEMON_RESET SESSION=$SessionId PID=$($target.Id)"
            $target.Kill($true)
            if (-not $target.WaitForExit(5000)) { throw 'daemon 终止超时。' }
        } elseif ($target) { throw 'daemon PID 身份发生变化，停止清理。' }
    } else {
        Write-Host "DEVTOOLS_STALE_PID SESSION=$SessionId PID=$($state.Raw) PROCESS=$($state.Process.Name)"
    }
    # 只删除未被其他启动操作替换的单个状态文件。
    if ((Test-Path -LiteralPath $state.File) -and [IO.File]::ReadAllText($state.File).Trim() -eq $state.Raw) {
        Remove-Item -LiteralPath $state.File -Force
    }
}
