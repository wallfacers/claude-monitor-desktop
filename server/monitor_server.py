import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class StatusStore:
    """In-memory table of Claude Code window statuses, keyed by session_id."""

    def __init__(self, stale_sec=600):
        self.stale_sec = stale_sec
        self._windows = {}

    def update(self, session_id, status, cwd, now):
        win = self._windows.get(session_id)
        name = os.path.basename(cwd.rstrip("/")) if cwd else session_id

        if status == "heartbeat":
            if win is None:
                self._windows[session_id] = {
                    "id": session_id, "status": "running",
                    "name": name, "run_started": now, "last_seen": now,
                }
            else:
                win["last_seen"] = now
                if cwd:
                    win["name"] = name
            return

        if status == "running":
            run_started = now
        else:
            run_started = win["run_started"] if win else now

        self._windows[session_id] = {
            "id": session_id, "status": status,
            "name": name, "run_started": run_started, "last_seen": now,
        }

    def get_state(self, now):
        visible = []
        for win in self._windows.values():
            age = now - win["last_seen"]
            if win["status"] == "done" and age > self.stale_sec:
                continue
            visible.append(win)

        basename_counts = {}
        for win in visible:
            basename_counts[win["name"]] = basename_counts.get(win["name"], 0) + 1

        windows = []
        statuses = set()
        for win in visible:
            statuses.add(win["status"])
            name = win["name"]
            if basename_counts[name] > 1:
                name = "{}#{}".format(name, win["id"][:5])
            idle = int(now - win["last_seen"])
            windows.append(
                {
                    "id": win["id"],
                    "status": win["status"],
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

    return Handler


def create_server(host, port, store=None, clock=time.time):
    store = store if store is not None else StatusStore()
    return ThreadingHTTPServer((host, port), make_handler(store, clock))


def main():
    host = os.environ.get("MONITOR_HOST", "127.0.0.1")
    port = int(os.environ.get("MONITOR_PORT", "8787"))
    stale = int(os.environ.get("MONITOR_STALE_SEC", "600"))
    server = create_server(host, port, store=StatusStore(stale_sec=stale))
    print("claude-monitor server on http://{}:{}  (GET /state, POST /api/window-status)".format(host, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
