function Resolve-ChromiumExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('chrome', 'msedge')]
        [string]$Browser
    )

    $exeName = "$Browser.exe"
    $command = Get-Command $exeName -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($registryPath in @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
    )) {
        try {
            $value = (Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop).'(default)'
            if ($value -and (Test-Path -LiteralPath $value)) {
                return $value
            }
        } catch {}
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $candidates = if ($Browser -eq 'msedge') {
        @(
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "$programFilesX86\Microsoft\Edge\Application\msedge.exe",
            "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
        )
    } else {
        @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "$programFilesX86\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
        )
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    throw "未找到浏览器可执行文件: $exeName"
}

function Get-ChromiumProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('chrome', 'msedge')]
        [string]$Browser
    )

    return @(Get-Process -Name $Browser -ErrorAction SilentlyContinue)
}

function Ensure-ChromiumNativeWindowType {
    if ('ChromiumConnectNativeWindow' -as [type]) {
        return
    }

    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ChromiumConnectNativeWindow {
    private static volatile bool suppressFlash;
    private static Thread suppressFlashThread;
    private static IntPtr[] suppressFlashHandles = Array.Empty<IntPtr>();

    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    private static void StopFlashing(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return;
        var info = new FLASHWINFO {
            cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)),
            hwnd = hWnd,
            dwFlags = 0,
            uCount = 0,
            dwTimeout = 0,
        };
        FlashWindowEx(ref info);
    }

    public static void StartFlashSuppression(IntPtr[] handles) {
        StopFlashSuppression();
        suppressFlashHandles = handles ?? Array.Empty<IntPtr>();
        suppressFlash = true;
        suppressFlashThread = new Thread(() => {
            while (suppressFlash) {
                foreach (var handle in suppressFlashHandles) StopFlashing(handle);
                Thread.Sleep(5);
            }
            foreach (var handle in suppressFlashHandles) StopFlashing(handle);
        });
        suppressFlashThread.IsBackground = true;
        suppressFlashThread.Start();
    }

    public static void StopFlashSuppression() {
        suppressFlash = false;
        var thread = suppressFlashThread;
        suppressFlashThread = null;
        if (thread != null && thread.IsAlive) thread.Join(250);
        foreach (var handle in suppressFlashHandles) StopFlashing(handle);
        suppressFlashHandles = Array.Empty<IntPtr>();
    }
}
'@
}

function Minimize-ChromiumWindow {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('chrome', 'msedge')]
        [string]$Browser
    )

    Ensure-ChromiumNativeWindowType

    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $windowProcess = Get-Process -Name $Browser -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
        if ($windowProcess) {
            [void][ChromiumConnectNativeWindow]::ShowWindowAsync([IntPtr]$windowProcess.MainWindowHandle, 6)
            Start-Sleep -Milliseconds 150
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
}

function Ensure-ChromiumRunning {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('chrome', 'msedge')]
        [string]$Browser
    )

    $processes = Get-ChromiumProcesses -Browser $Browser
    if ($processes.Count -gt 0) {
        return [pscustomobject]@{
            Started = $false
            Process = $null
            Processes = $processes
        }
    }

    $exe = Resolve-ChromiumExecutable -Browser $Browser
    Write-Host "BROWSER_START=$Browser PATH=$exe"
    $startedProcess = Start-Process -FilePath $exe -ArgumentList '--start-minimized' -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 200
        $processes = Get-ChromiumProcesses -Browser $Browser
        if ($processes.Count -gt 0) {
            Minimize-ChromiumWindow -Browser $Browser
            return [pscustomobject]@{
                Started = $true
                Process = $startedProcess
                Processes = $processes
            }
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "启动 $Browser 后 12 秒内未检测到浏览器进程。"
}

function Stop-ChromiumProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process
    )

    if (-not $Process -or $Process.HasExited) {
        return
    }

    try {
        & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    } catch {
        try {
            $Process.Kill()
        } catch {}
    }
}

function Initialize-ChromiumRemoteDebuggingAuthorization {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('chrome', 'msedge')]
        [string]$Browser
    )

    Ensure-ChromiumNativeWindowType
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    $script:chromiumAuthorizationBrowser = $Browser
    $script:chromiumAuthorizationTitles = @(
        '要允许远程调试吗？',
        '是否允许远程调试?',
        '是否允许远程调试？',
        'Allow remote debugging?'
    )
    $script:chromiumAuthorizationButtons = @('允许', 'Allow')
    $script:chromiumRemoteDebuggingDialogHandle = [IntPtr]::Zero

    $script:chromiumBrowserMainWindowHandles = @(
        Get-Process -Name $Browser -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            ForEach-Object { [IntPtr]$_.MainWindowHandle }
    )
    $script:chromiumMinimizedBrowserWindowHandles = @(
        $script:chromiumBrowserMainWindowHandles |
            Where-Object { [ChromiumConnectNativeWindow]::IsIconic($_) }
    )

    $typeCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
    )
    $script:chromiumAuthorizationButtonConditions = foreach ($buttonName in $script:chromiumAuthorizationButtons) {
        $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $buttonName
        )
        New-Object System.Windows.Automation.AndCondition($nameCondition, $typeCondition)
    }
}

function Stop-ChromiumWindowFlashing {
    param([IntPtr]$Handle)

    Ensure-ChromiumNativeWindowType
    if ($Handle -eq [IntPtr]::Zero -or -not [ChromiumConnectNativeWindow]::IsWindow($Handle)) {
        return
    }

    $info = New-Object ChromiumConnectNativeWindow+FLASHWINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'ChromiumConnectNativeWindow+FLASHWINFO')
    $info.hwnd = $Handle
    $info.dwFlags = 0
    $info.uCount = 0
    $info.dwTimeout = 0
    [void][ChromiumConnectNativeWindow]::FlashWindowEx([ref]$info)
}

function Stop-ChromiumBrowserWindowFlashing {
    foreach ($handle in @($script:chromiumBrowserMainWindowHandles)) {
        Stop-ChromiumWindowFlashing -Handle $handle
    }
    if ($script:chromiumRemoteDebuggingDialogHandle -ne [IntPtr]::Zero) {
        Stop-ChromiumWindowFlashing -Handle $script:chromiumRemoteDebuggingDialogHandle
    }
}

function Restore-ChromiumMinimizedWindows {
    foreach ($handle in @($script:chromiumMinimizedBrowserWindowHandles)) {
        if (
            [ChromiumConnectNativeWindow]::IsWindow($handle) -and
            -not [ChromiumConnectNativeWindow]::IsIconic($handle)
        ) {
            [void][ChromiumConnectNativeWindow]::ShowWindowAsync($handle, 6)
        }
    }
}

function Invoke-ChromiumRemoteDebuggingAllow {
    # 先恢复连接前的最小化状态，再通过 UIA 调用授权按钮，缩短窗口遮挡时间。
    Restore-ChromiumMinimizedWindows
    $script:chromiumRemoteDebuggingDialogHandle = [IntPtr]::Zero
    $callback = [ChromiumConnectNativeWindow+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        $buffer = New-Object System.Text.StringBuilder 256
        [void][ChromiumConnectNativeWindow]::GetWindowText($hWnd, $buffer, $buffer.Capacity)
        if ($script:chromiumAuthorizationTitles -contains $buffer.ToString()) {
            $script:chromiumRemoteDebuggingDialogHandle = $hWnd
            return $false
        }
        return $true
    }

    [void][ChromiumConnectNativeWindow]::EnumWindows($callback, [IntPtr]::Zero)
    if ($script:chromiumRemoteDebuggingDialogHandle -eq [IntPtr]::Zero) {
        return $false
    }

    Stop-ChromiumBrowserWindowFlashing

    $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($script:chromiumRemoteDebuggingDialogHandle)
    foreach ($buttonCondition in $script:chromiumAuthorizationButtonConditions) {
        $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $buttonCondition)
        if (-not $button -or -not $button.Current.IsEnabled) {
            continue
        }

        try {
            $invoke = [System.Windows.Automation.InvokePattern]$button.GetCurrentPattern(
                [System.Windows.Automation.InvokePattern]::Pattern
            )
            $invoke.Invoke()
        } catch {
            continue
        }

        Stop-ChromiumBrowserWindowFlashing
        Restore-ChromiumMinimizedWindows
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 10
            Stop-ChromiumBrowserWindowFlashing
            if (-not [ChromiumConnectNativeWindow]::IsWindow($script:chromiumRemoteDebuggingDialogHandle)) {
                return $true
            }

            $buffer = New-Object System.Text.StringBuilder 256
            [void][ChromiumConnectNativeWindow]::GetWindowText(
                $script:chromiumRemoteDebuggingDialogHandle,
                $buffer,
                $buffer.Capacity
            )
            if ($script:chromiumAuthorizationTitles -notcontains $buffer.ToString()) {
                return $true
            }
        }
    }

    return $false
}

function Wait-ChromiumProcessWithAuthorization {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,

        [Parameter(Mandatory = $true)]
        [int]$WaitSeconds
    )

    $startedAt = [DateTime]::UtcNow
    $deadline = $startedAt.AddSeconds([Math]::Min($WaitSeconds, 10))
    $clickCount = 0

    while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        if (Invoke-ChromiumRemoteDebuggingAllow) {
            $clickCount++
        }
        Stop-ChromiumBrowserWindowFlashing
        if (-not $Process.HasExited) {
            Start-Sleep -Milliseconds 100
        }
    }

    Stop-ChromiumBrowserWindowFlashing
    Restore-ChromiumMinimizedWindows

    if (-not $Process.HasExited) {
        Stop-ChromiumProcessTree -Process $Process
        try {
            $Process.WaitForExit(1000) | Out-Null
        } catch {}
        $Process.Dispose()
        return [pscustomobject]@{
            TimedOut = $true
            ExitCode = $null
            ClickCount = $clickCount
        }
    }

    $exitCode = $Process.ExitCode
    $Process.Dispose()
    return [pscustomobject]@{
        TimedOut = $false
        ExitCode = $exitCode
        ClickCount = $clickCount
    }
}
