# Manual run: node .\run-now.ps1 [--date YYYY-MM-DD] [--dry-run] [--force]
$script = Join-Path $PSScriptRoot 'standup.mjs'
& node $script @args
exit $LASTEXITCODE
