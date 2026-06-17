#!/usr/bin/env bash
# Claude Code hook (WSL / Linux / macOS): 读 stdin 的 hook JSON，
# 把事件映射成窗口状态，POST 到本地 claude-monitor 服务。
# 与 report-status.ps1 对称；设计为绝不阻塞 Claude Code：任何失败都静默退出 0。
# hook JSON 经 stdin 传入；环境变量 MONITOR_URL 可覆盖上报地址。
# 实现用 python3 解析 JSON（WSL 必装），-c 模式不占 stdin，hook JSON 仍走 stdin。
python3 -c '
import sys, os, json, urllib.request
try:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    ev = data.get("hook_event_name", "")
    status = {
        "SessionStart": "start",
        "UserPromptSubmit": "running",
        "PostToolUse": "heartbeat",
        "Stop": "done",
        "SessionEnd": "end",
        # PermissionRequest：权限对话框一出现即触发（即时，无 Notification 的已知延迟）。
        # 「待确认」最灵敏的信号；批准后的 PostToolUse 心跳会把 waiting 翻回 running。
        "PermissionRequest": "waiting",
    }.get(ev)
    if ev == "Notification":
        # Notification 同时用于「需批准工具调用」和「空闲 60s 等待输入」。
        # 用 notification_type 区分：idle_prompt=已完成在等输入（非待确认），
        # permission_prompt=真·需确认。旧版本无此字段时用 message 文本兜底。
        ntype = str(data.get("notification_type", ""))
        msg = str(data.get("message", "")).lower()
        if ntype == "permission_prompt":
            status = "waiting"
        elif ntype == "idle_prompt":
            status = "done"
        elif ntype == "auth_success" or ntype.startswith("elicitation_"):
            sys.exit(0)
        elif "waiting for your input" in msg or "is idle" in msg:
            status = "done"
        else:
            status = "waiting"
    if status is None:
        sys.exit(0)
    url = os.environ.get("MONITOR_URL", "http://127.0.0.1:8787/api/window-status")
    body = json.dumps({
        "session_id": data.get("session_id"),
        "status": status,
        "cwd": data.get("cwd", ""),
        "event": ev,
    }).encode()
    # 绕过系统代理（本机直连 127.0.0.1）
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    opener.open(req, timeout=2).read()
except Exception:
    pass
'
exit 0
