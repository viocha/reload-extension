function Get-PlaywrightSessionFile([string]$CliSource, [string]$SessionName) {
    $dir = (Get-Location).Path
    $workspaceDir = $null
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-Path -LiteralPath (Join-Path $dir '.playwright')) { $workspaceDir = $dir; break }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    $packageRoot = $playwrightCoreRoot
    $hashInput = if ($workspaceDir) { $workspaceDir } else { $packageRoot }
    $sha1 = [Security.Cryptography.SHA1]::Create()
    try { $hash = $sha1.ComputeHash([Text.Encoding]::UTF8.GetBytes($hashInput)) }
    finally { $sha1.Dispose() }
    $workspaceHash = ([Convert]::ToHexString($hash)).ToLowerInvariant().Substring(0, 16)
    return Join-Path $env:LOCALAPPDATA "ms-playwright\daemon\$workspaceHash\$SessionName.session"
}

function Read-PlaywrightSessionJson([string]$Path) {
    try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
    catch { return $null }
}

function Save-PlaywrightBrowserBinding([string]$SessionFile, [string]$Browser, [switch]$ReadOnly) {
    $config = Read-PlaywrightSessionJson $SessionFile
    if (-not $config.attached -or -not $config.socketPath) { throw '连接完成后未找到有效的 Playwright session。' }
    $binding = @{ browser = $Browser; timestamp = $config.timestamp; socketPath = $config.socketPath; readOnly = [bool]$ReadOnly }
    [IO.File]::WriteAllText("$SessionFile.browser.json", ($binding | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

function Test-PlaywrightBrowserBinding([string]$SessionFile, [string]$Browser, [switch]$ReadOnly) {
    $config = Read-PlaywrightSessionJson $SessionFile
    $binding = Read-PlaywrightSessionJson "$SessionFile.browser.json"
    if (-not $config.attached -or -not $config.socketPath -or $binding.browser -ne $Browser -or
        $binding.timestamp -ne $config.timestamp -or $binding.socketPath -ne $config.socketPath -or
        [bool]$binding.readOnly -ne [bool]$ReadOnly) { return $false }
    if (-not (Test-Path -LiteralPath $config.socketPath -ErrorAction SilentlyContinue)) { return $false }
    try {
        $browserStarted = (Get-ChromiumProcesses -Browser $Browser | Sort-Object StartTime | Select-Object -First 1).StartTime.ToUniversalTime()
        $sessionStarted = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$config.timestamp).UtcDateTime
        return $sessionStarted -ge $browserStarted.AddSeconds(-1)
    } catch { return $false }
}

function Get-PlaywrightCommandName([string[]]$Arguments) {
    $index = 0
    while ($index -lt $Arguments.Count -and $Arguments[$index] -in @('--raw', '--json')) { $index++ }
    if ($index -lt $Arguments.Count) { return $Arguments[$index] }
    return ''
}
