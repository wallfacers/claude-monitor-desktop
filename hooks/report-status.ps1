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
        "Stop"             { $status = "done" }
        "SessionEnd"       { $status = "end" }
        "Notification" {
            # Notification 同时用于「需批准工具调用」和「空闲 60s 等待输入」。
            # 用 notification_type 区分：idle_prompt=已完成在等输入（非待确认），
            # permission_prompt=真·需确认。旧版本无此字段时用 message 文本兜底。
            $ntype = "$($data.notification_type)"
            $msg   = "$($data.message)"
            if     ($ntype -eq "permission_prompt") { $status = "waiting" }
            elseif ($ntype -eq "idle_prompt")       { $status = "done" }
            elseif ($ntype -eq "auth_success" -or $ntype -like "elicitation_*") { exit 0 }
            elseif ($msg -match "waiting for your input|is idle") { $status = "done" }
            else   { $status = "waiting" }
        }
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
