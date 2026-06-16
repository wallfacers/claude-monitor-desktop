# Claude Code hook (Windows / PowerShell): 读 stdin 的 hook JSON，
# 把事件映射成窗口状态，POST 到本地 claude-monitor 服务。
# 设计为绝不阻塞 Claude Code：任何失败都静默 exit 0。
$ErrorActionPreference = "SilentlyContinue"
try {
    $raw  = [Console]::In.ReadToEnd()
    $data = $raw | ConvertFrom-Json

    switch ($data.hook_event_name) {
        "SessionStart"     { $status = "start" }
        "UserPromptSubmit" { $status = "running" }
        "PostToolUse"      { $status = "heartbeat" }
        "Notification"     { $status = "waiting" }
        "Stop"             { $status = "done" }
        "SessionEnd"       { $status = "end" }
        default            { exit 0 }
    }

    $url = if ($env:MONITOR_URL) { $env:MONITOR_URL } else { "http://127.0.0.1:8787/api/window-status" }
    $body = @{
        session_id = $data.session_id
        status     = $status
        cwd        = $data.cwd
        event      = $data.hook_event_name
    } | ConvertTo-Json -Compress

    Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $body -TimeoutSec 2 | Out-Null
} catch { }
exit 0
