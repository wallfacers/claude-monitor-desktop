import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class StatusStore:
    """In-memory table of Claude Code window statuses, keyed by session_id."""

    def __init__(self, stale_sec=7200, auto_done_sec=1800):
        # stale_sec 是兜底超时：超过它仍无任何 hook 事件 -> 移除记录。
        # 正常退出(/exit、Ctrl+C/D)走 SessionEnd 即时移除；硬关闭终端/kill-9 不发
        # SessionEnd，靠这个兜底清理「幽灵」。默认 2h：够长不误删空闲会话，又不会留一天。
        self.stale_sec = stale_sec
        # auto_done_sec：running 超过它仍无任何回调 -> 视为完成（取消/打断/已死）。
        # Claude Code 打断(ESC)不发任何 hook，无法区分「取消」与「卡住」，故用超长兜底；
        # 阈值远晚于「卡住」警告(10min)，让真正卡住的长任务先以 running+警告 暴露足够久。
        self.auto_done_sec = auto_done_sec
        self._windows = {}

    def update(self, session_id, status, cwd, now):
        win = self._windows.get(session_id)
        # 名称取自 cwd；无 cwd（如手动清除的 POST）则保留原名，不退化成 session_id
        if cwd:
            name = os.path.basename(cwd.rstrip("/"))
        elif win:
            name = win["name"]
        else:
            name = session_id

        # SessionEnd：会话真正结束（/exit、Ctrl+C、Ctrl+D、超时…）-> 移除窗口
        if status == "end":
            self._windows.pop(session_id, None)
            return

        # SessionStart / heartbeat：确保窗口存在并刷新活跃度
        if status in ("start", "heartbeat"):
            if win is None:
                # start -> 就绪(done)；heartbeat 收到未知会话 -> 视为运行中
                initial = "running" if status == "heartbeat" else "done"
                self._windows[session_id] = {
                    "id": session_id, "status": initial,
                    "name": name, "run_started": now, "last_seen": now,
                }
                return
            win["last_seen"] = now
            if cwd:
                win["name"] = name
            # PostToolUse 心跳兜底识别「新一轮」：有些 CLI 不发 UserPromptSubmit，
            # 否则计时会一直从启动算（显示成「启动时间」而非当前任务时长）。
            if status == "heartbeat":
                if win["status"] == "done":
                    # 上一轮已结束后又出现工具调用 = 新一轮开始 -> 转 running 并重锚计时
                    win["status"] = "running"
                    win["run_started"] = now
                elif win["status"] == "waiting":
                    # 等待(权限确认)被批准后继续同一轮 -> 转回 running，但不重置计时
                    win["status"] = "running"
            # SessionStart(start) 落到已存在窗口：仅刷新活跃度，不降级状态/不重置计时
            return

        if status == "running":
            run_started = now            # 新一轮 prompt = 新的计时起点
        else:
            run_started = win["run_started"] if win else now

        self._windows[session_id] = {
            "id": session_id, "status": status,
            "name": name, "run_started": run_started, "last_seen": now,
        }

    def get_state(self, now):
        visible = []
        for win in self._windows.values():
            # 唯一的时间清理：超长无任何事件的兜底（专杀 kill-9/关终端 残留）。
            # 正常关闭走 SessionEnd 即时移除；活跃/卡住/空闲会话都在 stale_sec 内保留。
            if now - win["last_seen"] > self.stale_sec:
                continue
            visible.append(win)

        basename_counts = {}
        for win in visible:
            basename_counts[win["name"]] = basename_counts.get(win["name"], 0) + 1

        windows = []
        statuses = set()
        for win in visible:
            idle = int(now - win["last_seen"])
            status = win["status"]
            # 自动兜底：running 且超长无任何回调 -> 视为完成（取消/打断/已死）。
            # 不改存储状态：若工具心跳恢复，下次自然又显示 running（长任务自愈）。
            if status == "running" and idle >= self.auto_done_sec:
                status = "done"
            statuses.add(status)
            name = win["name"]
            if basename_counts[name] > 1:
                name = "{}#{}".format(name, win["id"][:5])
            windows.append(
                {
                    "id": win["id"],
                    "status": status,
                    "name": name,
                    "run_sec": int(now - win["run_started"]),
                    "idle_sec": idle,
                    "age_sec": idle,
                }
            )
        return {
            "windows": windows,
            "aggregate": self._aggregate(statuses),
            "ts": now,
        }

    @staticmethod
    def _aggregate(statuses):
        for level in ("waiting", "running", "done"):
            if level in statuses:
                return level
        return "idle"


def make_handler(store, clock):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # keep stdout clean

        def _send_json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/healthz":
                self._send_json(200, {"ok": True})
            elif self.path == "/state":
                self._send_json(200, store.get_state(now=clock()))
            else:
                self._send_json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/api/window-status":
                self._send_json(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            try:
                data = json.loads(raw)
                session_id = data["session_id"]
                status = data["status"]
            except (ValueError, KeyError, TypeError):
                self._send_json(400, {"error": "bad request"})
                return
            store.update(
                session_id=session_id,
                status=status,
                cwd=data.get("cwd", ""),
                now=clock(),
            )
            self._send_json(200, {"ok": True})

        def do_OPTIONS(self):
            # CORS 预检：跨源 POST(application/json) 会先发 OPTIONS；放行后浏览器才真正发 POST，
            # 否则 Tauri webview 里的 postStatus（行内 ✕ 移除记录）被拦截 → 点击无效果。
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()

    return Handler


def create_server(host, port, store=None, clock=time.time):
    store = store if store is not None else StatusStore()
    return ThreadingHTTPServer((host, port), make_handler(store, clock))


def main():
    host = os.environ.get("MONITOR_HOST", "127.0.0.1")
    port = int(os.environ.get("MONITOR_PORT", "8787"))
    stale = int(os.environ.get("MONITOR_STALE_SEC", "7200"))
    auto_done = int(os.environ.get("MONITOR_AUTODONE_SEC", "1800"))
    server = create_server(host, port, store=StatusStore(stale_sec=stale, auto_done_sec=auto_done))
    print("claude-monitor server on http://{}:{}  (GET /state, POST /api/window-status)".format(host, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
