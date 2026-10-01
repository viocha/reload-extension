param(
    [switch]$CloseStartedBrowser,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

& "$PSScriptRoot/browser-cli-wrapper.ps1" -Browser chrome -CloseStartedBrowser:$CloseStartedBrowser @CliArgs
