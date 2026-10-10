param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('chrome', 'msedge')]
    [string]$Browser,

    [ValidateRange(1, 10)]
    [int]$TimeoutSeconds = 5,

    [string]$Session = '',

    [switch]$ListTabs,

    [switch]$ProbeOnly,

    [switch]$ReuseSession,

    [switch]$ReadOnly,

    [string[]]$CommandArgs,

    [ValidateRange(1, 10)]
    [int]$CommandTimeoutSeconds = 10,

    [switch]$DisconnectAfterCommand,

    [switch]$CloseStartedBrowser
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'chromium-connect.ps1')
. (Join-Path $PSScriptRoot 'package-runtime.ps1')
. (Join-Path $PSScriptRoot 'session-state.ps1')
if ($ReadOnly -and $CommandArgs -and (Get-PlaywrightCommandName $CommandArgs) -ne 'eval') {
    throw '-ReadOnly 只支持读取型 eval；脚本必须自行保证不修改页面。'
}

# CLI 与 core 入口由 package-runtime.ps1 从项目依赖解析。

function Start-PlaywrightCliProcess(
    [string[]]$Arguments,
    [switch]$CaptureOutput,
    [switch]$SkipAttachSnapshot
) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $node.Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    if ($ReadOnly) {
        $startInfo.Environment['PLAYWRIGHT_MCP_TIMEOUT_SETTLE'] = '0'
    }
    if ($Browser -eq 'msedge') {
        $startInfo.Environment['PLAYWRIGHT_CLI_EDGE_DORMANT_TARGET_PATCH'] = '1'
    }
    if ($SkipAttachSnapshot) {
        $startInfo.Environment['PLAYWRIGHT_CLI_SKIP_ATTACH_SNAPSHOT'] = '1'
    }
    [void]$startInfo.ArgumentList.Add($cliEntry)
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    if ($CaptureOutput) {
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()

    $stdoutTask = $null
    $stderrTask = $null
    if ($CaptureOutput) {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
    }

    return [pscustomobject]@{
        Process = $process
        StdoutTask = $stdoutTask
        StderrTask = $stderrTask
    }
}

function Close-StartedBrowser {
    if (-not $CloseStartedBrowser -or -not $script:browserStartedByConnector -or -not $script:startedBrowserProcess) {
        return
    }

    if (-not $script:sessionDetached) {
        try { Invoke-PlaywrightCli "-s=$Session" detach *> $null } catch {}
    }

    Stop-ChromiumProcessTree -Process $script:startedBrowserProcess
}
if (-not $Session) {
    $Session = if ($Browser -eq 'msedge') { 'edge' } else { 'chrome' }
    if ($ReadOnly) { $Session += '-readonly' }
}
$sessionFile = Get-PlaywrightSessionFile -CliSource $cli.Source -SessionName $Session
$script:sessionDetached = $false

function Ensure-AttachNoSnapshotPatch {
    $cliDir = Split-Path -Parent $cli.Source
    $programFile = Join-Path $playwrightCoreRoot 'lib/tools/cli-client/program.js'
    if (-not (Test-Path -LiteralPath $programFile)) {
        throw "找不到 Playwright program.js，无法应用 attach no-snapshot 补丁: $programFile"
    }

    $source = [System.IO.File]::ReadAllText($programFile)
    $marker = 'PLAYWRIGHT_CLI_SKIP_ATTACH_SNAPSHOT'
    if ($source.Contains($marker)) {
        return
    }

    $old = '      const toolText = await runInSessionOrStop(newEntry, clientInfo, { _: ["snapshot"], filename: "<auto>" }, output);'
    $new = '      const toolText = process.env.PLAYWRIGHT_CLI_SKIP_ATTACH_SNAPSHOT ? void 0 : await runInSessionOrStop(newEntry, clientInfo, { _: ["snapshot"], filename: "<auto>" }, output);'
    if (-not $source.Contains($old)) {
        if (-not $source.Contains('{ _: ["snapshot"], filename: "<auto>" }')) {
            Write-Host 'ATTACH_SNAPSHOT_PATCH=not-needed'
            return
        }
        throw '当前 Playwright 仍包含 attach 自动 snapshot，但源码结构与已验证版本不同，拒绝模糊修改。'
    }

    $patched = $source.Replace($old, $new)
    [System.IO.File]::WriteAllText($programFile, $patched, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'ATTACH_SNAPSHOT_PATCH=applied'
}

function Ensure-EdgeDormantTargetPatch {
    if ($Browser -ne 'msedge') {
        return
    }

    $cliDir = Split-Path -Parent $cli.Source
    $coreBundle = Join-Path $playwrightCoreRoot 'lib/coreBundle.js'
    if (-not (Test-Path $coreBundle)) {
        throw "找不到 Playwright coreBundle.js，无法应用 Edge dormant target 兼容补丁: $coreBundle"
    }

    $source = [System.IO.File]::ReadAllText($coreBundle)
    $marker = 'PLAYWRIGHT_CLI_EDGE_DORMANT_TARGET_PATCH'
    if ($source.Contains($marker)) {
        return
    }

    $newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
    $needle = @(
        '      _onAttachedToTarget({ targetInfo, sessionId, waitingForDebugger }) {'
        '        if (targetInfo.type === "browser")'
        '          return;'
        '        const session2 = this._session.createChildSession(sessionId);'
    ) -join $newline
    $replacement = @(
        '      _onAttachedToTarget({ targetInfo, sessionId, waitingForDebugger }) {'
        '        if (targetInfo.type === "browser")'
        '          return;'
        '        // PLAYWRIGHT_CLI_EDGE_DORMANT_TARGET_PATCH: Edge can expose discarded page targets with pid=0.'
        '        if (process.env.PLAYWRIGHT_CLI_EDGE_DORMANT_TARGET_PATCH === "1" && targetInfo.type === "page" && targetInfo.pid === 0) {'
        '          const dormantSession = this._session.createChildSession(sessionId);'
        '          dormantSession.detach().catch(() => {'
        '          });'
        '          return;'
        '        }'
        '        const session2 = this._session.createChildSession(sessionId);'
    ) -join $newline

    if (-not $source.Contains($needle)) {
        throw '当前 Playwright coreBundle.js 结构与已验证版本不匹配，未自动修改第三方文件。'
    }

    $patched = $source.Replace($needle, $replacement)
    [System.IO.File]::WriteAllText($coreBundle, $patched, (New-Object System.Text.UTF8Encoding($false)))
}

$browserState = Ensure-ChromiumRunning -Browser $Browser
$script:browserStartedByConnector = $browserState.Started
$script:startedBrowserProcess = $browserState.Process
Initialize-ChromiumRemoteDebuggingAuthorization -Browser $Browser
function Invoke-CliCommand(
    [string[]]$Arguments,
    [switch]$CaptureOutput,
    [switch]$SkipAttachSnapshot,
    [int]$WaitSeconds = $TimeoutSeconds
) {
    [ChromiumConnectNativeWindow]::StartFlashSuppression([IntPtr[]]$script:chromiumBrowserMainWindowHandles)
    try {
        $started = Start-PlaywrightCliProcess -Arguments $Arguments -CaptureOutput:$CaptureOutput -SkipAttachSnapshot:$SkipAttachSnapshot
        $process = $started.Process
        $result = Wait-ChromiumProcessWithAuthorization -Process $process -WaitSeconds $WaitSeconds

        $stdout = ''
        $stderr = ''
        if ($CaptureOutput -and -not $result.TimedOut) {
            $stdout = $started.StdoutTask.GetAwaiter().GetResult()
            $stderr = $started.StderrTask.GetAwaiter().GetResult()
        }

        return [pscustomobject]@{
            TimedOut = $result.TimedOut
            ExitCode = $result.ExitCode
            ClickCount = $result.ClickCount
            Stdout = $stdout
            Stderr = $stderr
        }
    } finally {
        [ChromiumConnectNativeWindow]::StopFlashSuppression()
    }
}

try {
    Ensure-AttachNoSnapshotPatch
    Ensure-EdgeDormantTargetPatch

    if ($ProbeOnly) {
        $probeResult = Invoke-CliCommand -Arguments @("-s=$Session", 'tab-list') -CaptureOutput
        if ($probeResult.TimedOut) {
            throw "tab-list 授权探针在 $TimeoutSeconds 秒内未完成。"
        }
        if ($probeResult.ExitCode -ne 0) {
            throw "tab-list 授权探针失败，退出码 $($probeResult.ExitCode)。"
        }

        $userAgentResult = Invoke-CliCommand -Arguments @("-s=$Session", '--raw', 'eval', 'navigator.userAgent') -CaptureOutput
        if ($userAgentResult.TimedOut) {
            throw "浏览器类型探针在 $TimeoutSeconds 秒内未完成。"
        }
        if ($userAgentResult.ExitCode -ne 0) {
            throw "浏览器类型探针失败，退出码 $($userAgentResult.ExitCode)。"
        }

        $userAgent = $userAgentResult.Stdout.Trim().Trim('"')
        $matchesBrowser = if ($Browser -eq 'msedge') {
            $userAgent -match '\bEdg/'
        } else {
            $userAgent -match '\bChrome/' -and $userAgent -notmatch '\bEdg/'
        }
        if (-not $matchesBrowser) {
            throw "当前 Playwright session 未连接到目标浏览器 $Browser。User-Agent: $userAgent"
        }

        Write-Output "PROBE_ONLY=true BROWSER=$Browser SESSION=$Session CLICKS=$($probeResult.ClickCount)"
        return
    }

    if (-not $ReuseSession -or -not (Test-PlaywrightBrowserBinding -SessionFile $sessionFile -Browser $Browser -ReadOnly:$ReadOnly)) {
        if ($ReuseSession -and (Test-Path -LiteralPath $sessionFile)) {
            Invoke-PlaywrightCli "-s=$Session" detach *> $null
        }
        $firstResult = Invoke-CliCommand -Arguments @('attach', "--cdp=$Browser", "--session=$Session") -SkipAttachSnapshot

        if ($firstResult.TimedOut) {
            throw "CDP attach 在 $TimeoutSeconds 秒内未完成。请检查 Remote Debugging 授权、Playwright cliDaemon 或异常 target。授权点击次数: $($firstResult.ClickCount)。"
        }
        if ($firstResult.ExitCode -ne 0) {
            throw "CDP attach 失败，退出码 $($firstResult.ExitCode)。$([Environment]::NewLine)$($firstResult.Stderr.Trim())$([Environment]::NewLine)$($firstResult.Stdout.Trim())"
        }

        if ($script:browserStartedByConnector) {
            Minimize-ChromiumWindow -Browser $Browser
        }
        Write-Output "ATTACHED_BROWSER=$Browser SESSION=$Session CLICKS=$($firstResult.ClickCount)"
        Save-PlaywrightBrowserBinding -SessionFile $sessionFile -Browser $Browser -ReadOnly:$ReadOnly
    }

    if ($CommandArgs) {
        $commandResult = Invoke-CliCommand -Arguments (@("-s=$Session") + $CommandArgs) -CaptureOutput -WaitSeconds $CommandTimeoutSeconds
        if ($commandResult.Stdout) { Write-Output $commandResult.Stdout.TrimEnd() }
        if ($commandResult.Stderr) { [Console]::Error.WriteLine($commandResult.Stderr.TrimEnd()) }
        if ($commandResult.TimedOut) { throw "Playwright 命令在 $CommandTimeoutSeconds 秒内未完成。" }
        if ($commandResult.ExitCode -ne 0 -or $commandResult.Stdout -match '(?m)^### Error\s*$') {
            throw "Playwright 命令失败，退出码 $($commandResult.ExitCode)。$([Environment]::NewLine)$($commandResult.Stdout.Trim())"
        }
    }

    if (-not $ListTabs) {
        return
    }

    $listResult = Invoke-CliCommand -Arguments @("-s=$Session", 'tab-list') -CaptureOutput
    if ($listResult.TimedOut) {
        throw "tab-list 在 $TimeoutSeconds 秒内未完成。"
    }
    if ($listResult.ExitCode -ne 0) {
        throw "tab-list 失败，退出码 $($listResult.ExitCode)。$([Environment]::NewLine)$($listResult.Stderr.Trim())$([Environment]::NewLine)$($listResult.Stdout.Trim())"
    }
    $listResult.Stdout.TrimEnd() | Write-Output
} finally {
    try {
        if ($DisconnectAfterCommand) {
            Invoke-PlaywrightCli "-s=$Session" detach | Out-Null
            $script:sessionDetached = $true
        }
    } finally {
        Close-StartedBrowser
    }
}
