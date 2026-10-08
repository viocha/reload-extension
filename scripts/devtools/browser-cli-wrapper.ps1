param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('chrome', 'msedge')]
    [string]$Browser,

    [switch]$CloseStartedBrowser,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

$ErrorActionPreference = 'Stop'

$sessionId = if ($Browser -eq 'msedge') { 'e10ad' } else { 'c10ad' }
$connectScript = Join-Path $PSScriptRoot 'connect-devtools-session.ps1'
. (Join-Path $PSScriptRoot 'chromium-connect.ps1')
. (Join-Path $PSScriptRoot 'package-runtime.ps1')
. (Join-Path $PSScriptRoot 'daemon-state.ps1')
$script:startedBrowserProcess = $null

function Get-BrowserProcesses {
    return Get-ChromiumProcesses -Browser $Browser
}

function Ensure-BrowserRunning {
    $state = Ensure-ChromiumRunning -Browser $Browser
    if ($state.Started) {
        $script:startedBrowserProcess = $state.Process
    }
    return $state
}

function Close-StartedBrowser {
    if (-not $CloseStartedBrowser -or -not $script:startedBrowserProcess) {
        return
    }

    try {
        Invoke-ChromeDevToolsCli stop "--sessionId=$sessionId" | Out-Null
    } catch {}

    Stop-ChromiumProcessTree -Process $script:startedBrowserProcess
}

function Test-DaemonHealthy([object[]]$BrowserProcesses) {
    $state = Get-DevToolsDaemonState
    if (-not $state.Owned -or -not $state.Pipe -or $state.Raw -ne [string]$state.Process.ProcessId) { return $false }
    try {
        $daemonProcess = Get-Process -Id $state.Process.ProcessId -ErrorAction Stop
    } catch {
        return $false
    }

    try {
        $browserStarted = ($BrowserProcesses | Sort-Object StartTime | Select-Object -First 1).StartTime.ToUniversalTime()
        $daemonStarted = $daemonProcess.StartTime.ToUniversalTime()
        if ($daemonStarted -lt $browserStarted.AddSeconds(-1)) {
            return $false
        }
    } catch {
        return $false
    }

    return $true
}

function Ensure-Connection {
    $browserState = Ensure-BrowserRunning
    if (-not $browserState.Started -and (Test-DaemonHealthy $browserState.Processes)) {
        try {
            & $connectScript -Browser $Browser -SessionId $sessionId -TimeoutSeconds 5 -ProbeOnly
            if ($?) {
                return
            }
        } catch {
            Write-Host "DEVTOOLS_PROBE_FAILED=$Browser SESSION=$sessionId"
        }
    }

    Write-Host "DEVTOOLS_CONNECT=$Browser SESSION=$sessionId"
    & $connectScript -Browser $Browser -SessionId $sessionId -TimeoutSeconds 15
    if (-not $?) {
        throw "连接 $Browser 失败"
    }
}

$sessionLock = Enter-DevToolsSessionLock
try {
    if (-not $CliArgs -or $CliArgs.Count -eq 0) {
        Invoke-ChromeDevToolsCli --help
        return
    }

    if ($CliArgs | Where-Object { $_ -match '^--sessionId(?:=|$)' }) {
        throw '该 wrapper 固定管理自己的 session，请不要传 --sessionId。'
    }

    $command = $CliArgs[0]
    if ($command -in @('--help', '-h', '--version')) {
        Invoke-ChromeDevToolsCli @CliArgs
        return
    }

    switch ($command) {
        'status' {
            Repair-DevToolsDaemonState
            Invoke-ChromeDevToolsCli @CliArgs "--sessionId=$sessionId"
            return
        }
        'stop' {
            Repair-DevToolsDaemonState
            Invoke-ChromeDevToolsCli @CliArgs "--sessionId=$sessionId"
            return
        }
        'start' {
            Ensure-BrowserRunning | Out-Null
            & $connectScript -Browser $Browser -SessionId $sessionId -TimeoutSeconds 15
            return
        }
        default {
            Ensure-Connection
            Invoke-ChromeDevToolsCli @CliArgs "--sessionId=$sessionId"
            return
        }
    }
} finally {
    try { Close-StartedBrowser } finally {
        $sessionLock.ReleaseMutex()
        $sessionLock.Dispose()
    }
}
