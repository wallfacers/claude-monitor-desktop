import json
import threading
import unittest
import urllib.error
import urllib.request

from monitor_server import StatusStore, create_server


def _post(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=2) as resp:
        return resp.status, json.loads(resp.read() or b"{}")


def _get(url):
    with urllib.request.urlopen(url, timeout=2) as resp:
        return resp.status, json.loads(resp.read() or b"{}")


class HttpServerTest(unittest.TestCase):
    def setUp(self):
        self.store = StatusStore(stale_sec=600)
        self.server = create_server("127.0.0.1", 0, store=self.store)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:{}".format(self.port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_healthz_ok(self):
        status, _ = _get(self.base + "/healthz")
        self.assertEqual(status, 200)

    def test_state_has_cors_header(self):
        # 浏览器/Tauri webview 跨源 fetch /state 需要此头
        with urllib.request.urlopen(self.base + "/state", timeout=2) as resp:
            self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")

    def test_post_status_then_get_state(self):
        status, _ = _post(
            self.base + "/api/window-status",
            {"session_id": "s1", "status": "waiting", "cwd": "/tmp/proj", "event": "Notification"},
        )
        self.assertEqual(status, 200)

        status, state = _get(self.base + "/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["aggregate"], "waiting")
        self.assertEqual(len(state["windows"]), 1)
        self.assertEqual(state["windows"][0]["name"], "proj")

    def test_bad_json_returns_400_and_server_survives(self):
        req = urllib.request.Request(
            self.base + "/api/window-status",
            data=b"{not json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=2)
        self.assertEqual(ctx.exception.code, 400)

        # server still alive
        status, _ = _get(self.base + "/healthz")
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
