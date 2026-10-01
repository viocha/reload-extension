param(
    [switch]$CloseStartedBrowser,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

& "$PSScriptRoot/browser-cli-wrapper.ps1" -Browser msedge -CloseStartedBrowser:$CloseStartedBrowser @CliArgs
