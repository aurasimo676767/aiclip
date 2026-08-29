# Sospende/riprende DAVVERO (a livello di thread del sistema operativo, non solo "in attesa")
# i processi pesanti della pipeline: ffmpeg, yt-dlp, e il server whisper locale (riconosciuto dalla
# riga di comando, dato che gira come python.exe e potrebbero esserci altri processi python).
# Verificato in pratica (vedi sessione di sviluppo): la CPU del processo resta ferma durante la
# sospensione e riprende a salire dopo il resume — non è un semplice "nice"/priorità bassa, è un
# vero stop.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("suspend", "resume")]
    [string]$Action
)

$sig = @'
[DllImport("kernel32.dll")]
public static extern IntPtr OpenThread(int dwDesiredAccess, bool bInheritHandle, uint dwThreadId);
[DllImport("kernel32.dll")]
public static extern uint SuspendThread(IntPtr hThread);
[DllImport("kernel32.dll")]
public static extern int ResumeThread(IntPtr hThread);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr hObject);
'@
Add-Type -MemberDefinition $sig -Name "ThreadCtl" -Namespace "ClipForge" -ErrorAction SilentlyContinue

$targets = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "ffmpeg.exe" -or
    $_.Name -eq "yt-dlp.exe" -or
    ($_.Name -like "python*.exe" -and $_.CommandLine -like "*server.py*")
}

$affected = @()
foreach ($target in $targets) {
    $proc = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    foreach ($t in $proc.Threads) {
        $h = [ClipForge.ThreadCtl]::OpenThread(0x0002, $false, $t.Id)
        if ($h -eq [IntPtr]::Zero) { continue }
        if ($Action -eq "suspend") {
            [ClipForge.ThreadCtl]::SuspendThread($h) | Out-Null
        } else {
            [ClipForge.ThreadCtl]::ResumeThread($h) | Out-Null
        }
        [ClipForge.ThreadCtl]::CloseHandle($h) | Out-Null
    }
    $affected += "$($target.Name) (pid $($target.ProcessId))"
}

Write-Output ($affected -join ", ")
