# Run from the Windows Startup shortcut or manually with PowerShell.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
# This launcher owns the tracker stored alongside this script.
$env:TRACKER_DATA_DIR = $PSScriptRoot
$launcherLog = Join-Path $PSScriptRoot 'startup.log'
$lockPath = Join-Path $PSScriptRoot '.tracker.lock'
$hash = [System.Security.Cryptography.SHA256]::Create()
$key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant()))).Replace('-', '')
$hash.Dispose()
$mutex = [Threading.Mutex]::new($false, "Local\GamePriceBot-$key")
$ownsMutex = $false

function Write-Status([string]$Message) {
    Add-Content -LiteralPath $launcherLog -Value "$(Get-Date -Format o) $Message"
}

try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()

    while ($true) {
        if (Test-Path -LiteralPath $lockPath) {
            $lockFile = Get-Item -LiteralPath $lockPath
            $ownerText = (Get-Content -LiteralPath $lockPath -Raw).Trim()
            $ownerId = 0
            $validOwner = [int]::TryParse($ownerText, [ref]$ownerId) -and $ownerId -gt 0
            $owner = if ($validOwner) { Get-Process -Id $ownerId -ErrorAction SilentlyContinue }
            # A pre-boot lock cannot belong to a running bot. For same-boot
            # crashes, require a valid, absent PID and allow lock creation to finish.
            $oldBoot = $lockFile.LastWriteTimeUtc -lt $bootTime
            $deadOwner = $validOwner -and -not $owner -and $lockFile.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddSeconds(-10)
            if ($oldBoot -or $deadOwner) {
                Remove-Item -LiteralPath $lockPath
                Write-Status 'Removed a stale tracker lock.'
            } elseif ($owner) {
                Write-Status 'A process already owns the tracker; leaving it running.'
                exit 0
            } else {
                Write-Status 'Tracker lock is recent or unreadable; retrying in 60 seconds.'
                Start-Sleep -Seconds 60
                continue
            }
        }

        # Keep the previous run's logs when restarting after a failure.
        foreach ($name in @('bot.log', 'bot-error.log')) {
            $path = Join-Path $PSScriptRoot $name
            if (Test-Path -LiteralPath $path) {
                Copy-Item -LiteralPath $path -Destination (Join-Path $PSScriptRoot "previous-$name") -Force
            }
        }
        Write-Status 'Starting the Discord bot.'
        $child = Start-Process -FilePath $node -ArgumentList '--env-file-if-exists=.env bot.ts' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'bot.log') -RedirectStandardError (Join-Path $PSScriptRoot 'bot-error.log') -Wait -PassThru
        Write-Status "Bot exited with code $($child.ExitCode)."
        if ($child.ExitCode -eq 0) { break }
        Write-Status 'Retrying in 60 seconds.'
        Start-Sleep -Seconds 60
    }
} catch {
    Write-Status "Launcher stopped: $($_.Exception.Message)"
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
