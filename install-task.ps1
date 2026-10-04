# Registers the auto-run: daily at 00:05 local time.
# standup.mjs targets "yesterday" when run before 06:00 and skips a
# day that was already sent manually, so manual + auto never duplicate.
# Default security context is the interactive user (runs when logged on).
# To run whether or not you're logged in, add -User "$env:USERNAME" -Password (Read-Host -AsSecureString) and re-register.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'standup.mjs'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $script)) { throw "standup.mjs not found at $script" }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At '00:05'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Description 'Daily standup: summarizes the day (Kilo sessions, second-brain notes, GitHub commits, new projects) and posts it to Discord.'

Register-ScheduledTask -TaskName 'DailyStandup' -InputObject $task -Force | Out-Null
Write-Host "Registered task 'DailyStandup' (daily 00:05)."
Write-Host "Test it manually first:  node `"$script`" --dry-run"
