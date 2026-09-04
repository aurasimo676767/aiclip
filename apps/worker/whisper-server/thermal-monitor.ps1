$logFile = "C:\Users\simoa\clipforge\apps\worker\whisper-server\thermal-monitor.log"

"timestamp,gpu_temp_c,gpu_power_w,gpu_util_pct,gpu_mem_used_mib" | Out-File -FilePath $logFile -Encoding utf8

while ($true) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    try {
        $gpu = & nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,memory.used --format=csv,noheader,nounits
    } catch {
        $gpu = "NA,NA,NA,NA"
    }
    "$ts,$gpu" | Out-File -FilePath $logFile -Encoding utf8 -Append
    Start-Sleep -Seconds 5
}
