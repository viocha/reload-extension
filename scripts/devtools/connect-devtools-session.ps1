param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('chrome', 'msedge')]
    [string]$Browser,

    [int]$TimeoutSeconds = 5,

    [string]$SessionId = '',

    [switch]$ListPages,

    [switch]$ProbeOnly,

    [switch]$CloseStartedBrowser
)

$ErrorActionPreference = 'Stop'

if (-not $SessionId) {
    $SessionId = if ($Browser -eq 'msedge') { 'e10ad' } else { 'c10ad' }
}
if ($SessionId -notmatch '^[a-fA-F0-9-]+$') {
    throw "SessionId 只能包含十六进制字符和 '-': $SessionId"
}

. (Join-Path $PSScriptRoot 'chromium-connect.ps1')

$packageRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$chromeDevToolsPackageRoot = Resolve-ChromeDevToolsPackageRoot -StartPath $packageRoot
$cliEntry = Join-Path $chromeDevToolsPackageRoot 'build\src\bin\chrome-devtools.js'
$node = Get-Command node.exe -ErrorAction Stop
if (-not (Test-Path -LiteralPath $cliEntry)) {
    throw "未找到项目依赖 chrome-devtools-mcp CLI: $cliEntry"
}

function Start-ChromeDevToolsCliProcess(
    [string[]]$Arguments,
    [switch]$CaptureOutput
) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $node.Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    if ($Browser -eq 'msedge') {
        $startInfo.Environment['CODE_MCP_EDGE_DORMANT_TARGET_PATCH'] = '1'
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

    try {
        & $node.Source $cliEntry stop "--sessionId=$SessionId" | Out-Null
    } catch {}

    Stop-ChromiumProcessTree -Process $script:startedBrowserProcess
}
function Ensure-DormantPageTargetCompatibility {
    if ($Browser -ne 'msedge') {
        return
    }

    try {
        $browserFile = Join-Path $chromeDevToolsPackageRoot 'build\src\BrowserManager.js'
        if (-not (Test-Path $browserFile)) {
            throw "未找到 chrome-devtools-mcp BrowserManager.js: $browserFile"
        }

        $content = [System.IO.File]::ReadAllText($browserFile)
        $marker = 'CODE_MCP_EDGE_DORMANT_TARGET_PATCH'
        if ($content.Contains($marker)) {
            Write-Host 'EDGE_DORMANT_TARGET_PATCH=already-applied'
            return
        }

        $needle = @'
    static makeTargetFilter(enableExtensions = false) {
        return function targetFilter(target) {
            const url = target.url();
            if (!url) {
                return true;
            }
            return isAllowedUrl(url, { categoryExtensions: enableExtensions });
        };
    }
'@
        $replacement = @'
    static makeTargetFilter(enableExtensions = false) {
        return function targetFilter(target) {
            const targetInfo = target._getTargetInfo?.();
            if (process.env.CODE_MCP_EDGE_DORMANT_TARGET_PATCH === '1' && target.type() === 'page' && targetInfo?.pid === 0) {
                logger?.('Ignoring dormant page target with pid=0', targetInfo.targetId, targetInfo.url);
                return false;
            }
            const url = target.url();
            if (!url) {
                return true;
            }
            return isAllowedUrl(url, { categoryExtensions: enableExtensions });
        };
    }
'@

        if (-not $content.Contains($needle)) {
            throw '当前 chrome-devtools-mcp 版本的 makeTargetFilter 实现与预期不符，未修改第三方文件。'
        }

        $patched = $content.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText(
            $browserFile,
            $patched,
            [System.Text.UTF8Encoding]::new($false)
        )
        Write-Host "EDGE_DORMANT_TARGET_PATCH=applied FILE=$browserFile"
    } catch {
        throw "应用 Edge dormant page target 兼容补丁失败: $($_.Exception.Message)"
    }
}

$browserState = Ensure-ChromiumRunning -Browser $Browser
$script:browserStartedByConnector = $browserState.Started
$script:startedBrowserProcess = $browserState.Process
Initialize-ChromiumRemoteDebuggingAuthorization -Browser $Browser
function Get-BrowserUserDataDir {
    if ($Browser -eq 'msedge') {
        return (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
    }
    return (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
}

function Get-BrowserExecutablePath {
    try {
        return Resolve-ChromiumExecutable -Browser $Browser
    } catch {
        return $null
    }
}
function Test-ExtensionCategorySupported {
    $browserExe = Get-BrowserExecutablePath
    if (-not $browserExe) {
        Write-Warning '无法检测浏览器版本；按当前 chrome-devtools-mcp 能力启用 extension category。'
        return $true
    }

    $version = (Get-Item -LiteralPath $browserExe).VersionInfo.ProductVersion
    $majorText = ($version -split '\.')[0]
    $major = 0
    if (-not [int]::TryParse($majorText, [ref]$major)) {
        Write-Warning "无法解析浏览器版本 $version；按当前 chrome-devtools-mcp 能力启用 extension category。"
        return $true
    }

    if ($major -lt 149) {
        Write-Warning "浏览器主版本 $major < 149，禁用 extension category。"
        return $false
    }
    return $true
}

function Get-StartArguments {
    $extensionsEnabled = Test-ExtensionCategorySupported
    $extensionsFlag = if ($extensionsEnabled) { '--categoryExtensions=true' } else { '--categoryExtensions=false' }
    $args = @('start', "--sessionId=$SessionId", $extensionsFlag, '--autoConnect')
    if ($Browser -eq 'msedge') {
        $edgeData = Get-BrowserUserDataDir
        $args += "--userDataDir=`"$edgeData`""
    }
    return $args
}

function Invoke-StartConnection {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    [ChromiumConnectNativeWindow]::StartFlashSuppression([IntPtr[]]$script:chromiumBrowserMainWindowHandles)
    try {
        $started = Start-ChromeDevToolsCliProcess -Arguments (Get-StartArguments)
        $process = $started.Process
        $result = Wait-ChromiumProcessWithAuthorization -Process $process -WaitSeconds $TimeoutSeconds
    } finally {
        [ChromiumConnectNativeWindow]::StopFlashSuppression()
    }
    $watch.Stop()

    Write-Host ("START_MS={0:N1} CLICKS={1} EXIT={2} SESSION={3}" -f $watch.Elapsed.TotalMilliseconds, $result.ClickCount, $result.ExitCode, $SessionId)

    if ($result.TimedOut) {
        throw "chrome-devtools start 在 $TimeoutSeconds 秒内未完成。"
    }
    if ($result.ExitCode -ne 0) {
        throw "chrome-devtools start 失败，退出码 $($result.ExitCode)。"
    }

    return $result
}

function Invoke-ListPages {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    [ChromiumConnectNativeWindow]::StartFlashSuppression([IntPtr[]]$script:chromiumBrowserMainWindowHandles)
    try {
        $started = Start-ChromeDevToolsCliProcess -Arguments @('list_pages', "--sessionId=$SessionId")
        $process = $started.Process
        $result = Wait-ChromiumProcessWithAuthorization -Process $process -WaitSeconds $TimeoutSeconds
    } finally {
        [ChromiumConnectNativeWindow]::StopFlashSuppression()
    }
    $watch.Stop()

    Write-Host ("LIST_MS={0:N1} CLICKS={1} EXIT={2} TIMEOUT={3} SESSION={4}" -f $watch.Elapsed.TotalMilliseconds, $result.ClickCount, $result.ExitCode, $result.TimedOut, $SessionId)
    return $result
}

function Invoke-ListPagesQuiet {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    [ChromiumConnectNativeWindow]::StartFlashSuppression([IntPtr[]]$script:chromiumBrowserMainWindowHandles)
    try {
        $started = Start-ChromeDevToolsCliProcess -Arguments @('list_pages', "--sessionId=$SessionId") -CaptureOutput
        $process = $started.Process
        $result = Wait-ChromiumProcessWithAuthorization -Process $process -WaitSeconds $TimeoutSeconds
    } finally {
        [ChromiumConnectNativeWindow]::StopFlashSuppression()
    }
    $watch.Stop()

    $stderr = ''
    if (-not $result.TimedOut -and $started.StderrTask) {
        $stderr = $started.StderrTask.GetAwaiter().GetResult().Trim()
        [void]$started.StdoutTask.GetAwaiter().GetResult()
    }

    Write-Host ("LIST_AUTH_MS={0:N1} CLICKS={1} EXIT={2} TIMEOUT={3} SESSION={4}" -f $watch.Elapsed.TotalMilliseconds, $result.ClickCount, $result.ExitCode, $result.TimedOut, $SessionId)
    if ($stderr -and ($result.TimedOut -or $result.ExitCode -ne 0)) {
        Write-Host $stderr
    }
    return $result
}

try {
    Ensure-DormantPageTargetCompatibility

    $totalWatch = [System.Diagnostics.Stopwatch]::StartNew()
    if ($ProbeOnly) {
        $listResult = Invoke-ListPagesQuiet
        if ($listResult.TimedOut) {
            throw "list_pages 授权探针在 $TimeoutSeconds 秒内未完成。"
        }
        if ($listResult.ExitCode -ne 0) {
            throw "list_pages 授权探针失败，退出码 $($listResult.ExitCode)。"
        }
        $totalWatch.Stop()
        Write-Host ("TOTAL_MS={0:N1} PROBE_ONLY=true SESSION={1}" -f $totalWatch.Elapsed.TotalMilliseconds, $SessionId)
        return
    }

    Invoke-StartConnection | Out-Null
    if (-not $ListPages) {
        $listResult = Invoke-ListPagesQuiet
        if ($listResult.TimedOut) {
            throw "list_pages 授权探针在 $TimeoutSeconds 秒内未完成。请检查 daemon、Remote Debugging 授权或异常 target。"
        }
        if ($listResult.ExitCode -ne 0) {
            throw "list_pages 授权探针失败，退出码 $($listResult.ExitCode)。"
        }
        if ($script:browserStartedByConnector) {
            Minimize-ChromiumWindow -Browser $Browser
        }
        $totalWatch.Stop()
        Write-Host ("TOTAL_MS={0:N1} LIST_PAGES=HIDDEN SESSION={1}" -f $totalWatch.Elapsed.TotalMilliseconds, $SessionId)
        return
    }
    $listResult = Invoke-ListPages

    if (-not $listResult.TimedOut -and $listResult.ExitCode -eq 0) {
        if ($script:browserStartedByConnector) {
            Minimize-ChromiumWindow -Browser $Browser
        }
        $totalWatch.Stop()
        Write-Host ("TOTAL_MS={0:N1} LIST_PAGES=VISIBLE SESSION={1}" -f $totalWatch.Elapsed.TotalMilliseconds, $SessionId)
        return
    }

    if ($listResult.TimedOut) {
        throw "list_pages 在 $TimeoutSeconds 秒内未完成。请检查 daemon、Remote Debugging 授权或异常 target。"
    }
    throw "list_pages 失败，退出码 $($listResult.ExitCode)。"
} finally {
    Close-StartedBrowser
}
