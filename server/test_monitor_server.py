import unittest

from monitor_server import StatusStore


class StatusStoreTest(unittest.TestCase):
    def test_update_then_get_returns_window_with_status_and_name(self):
        store = StatusStore(stale_sec=600)
        store.update(
            session_id="abc123",
            status="running",
            cwd="/home/wushengzhou/workspace/github/claude-monitor",
            now=1000.0,
        )

        state = store.get_state(now=1001.0)

        self.assertEqual(len(state["windows"]), 1)
        win = state["windows"][0]
        self.assertEqual(win["id"], "abc123")
        self.assertEqual(win["status"], "running")
        self.assertEqual(win["name"], "claude-monitor")

    def test_stale_window_is_dropped_from_state(self):
        store = StatusStore(stale_sec=600)
        store.update(session_id="old", status="done", cwd="/tmp/a", now=1000.0)

        # 601s later, no further updates -> done window considered closed
        state = store.get_state(now=1601.0)

        self.assertEqual(state["windows"], [])

    def test_recently_seen_window_survives(self):
        store = StatusStore(stale_sec=600)
        store.update(session_id="live", status="done", cwd="/tmp/a", now=1000.0)

        state = store.get_state(now=1599.0)  # within stale window

        self.assertEqual(len(state["windows"]), 1)

    def test_aggregate_waiting_beats_running_and_done(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s2", "waiting", "/tmp/b", now=1000.0)
        store.update("s3", "done", "/tmp/c", now=1000.0)

        self.assertEqual(store.get_state(now=1000.0)["aggregate"], "waiting")

    def test_aggregate_running_when_no_waiting(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s2", "done", "/tmp/b", now=1000.0)

        self.assertEqual(store.get_state(now=1000.0)["aggregate"], "running")

    def test_aggregate_done_when_all_done(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "done", "/tmp/a", now=1000.0)

        self.assertEqual(store.get_state(now=1000.0)["aggregate"], "done")

    def test_aggregate_idle_when_no_windows(self):
        store = StatusStore(stale_sec=600)

        self.assertEqual(store.get_state(now=1000.0)["aggregate"], "idle")

    def test_aggregate_ignores_stale_windows(self):
        store = StatusStore(stale_sec=600)
        store.update("done_but_stale", "done", "/tmp/a", now=1000.0)
        store.update("running_live", "running", "/tmp/b", now=1700.0)

        # at 1701: the done window is stale (>600s) -> aggregate should be running
        self.assertEqual(store.get_state(now=1701.0)["aggregate"], "running")

    def test_same_basename_windows_get_distinct_names(self):
        store = StatusStore(stale_sec=600)
        store.update("sessA", "running", "/home/u/proj1/src", now=1000.0)
        store.update("sessB", "running", "/home/u/proj2/src", now=1000.0)

        names = [w["name"] for w in store.get_state(now=1000.0)["windows"]]
        self.assertEqual(len(set(names)), 2)  # distinct
        for n in names:
            self.assertIn("src", n)

    def test_state_includes_timestamp_and_age(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)

        state = store.get_state(now=1042.0)

        self.assertEqual(state["ts"], 1042.0)
        self.assertEqual(state["windows"][0]["age_sec"], 42)


    def test_state_includes_run_sec_and_idle_sec(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)

        win = store.get_state(now=1030.0)["windows"][0]

        self.assertEqual(win["run_sec"], 30)
        self.assertEqual(win["idle_sec"], 30)

    def test_heartbeat_refreshes_idle_but_keeps_run_started_and_status(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s1", "heartbeat", "/tmp/a", now=1100.0)

        win = store.get_state(now=1100.0)["windows"][0]
        self.assertEqual(win["status"], "running")
        self.assertEqual(win["run_sec"], 100)
        self.assertEqual(win["idle_sec"], 0)

    def test_running_then_idle_grows_when_no_heartbeat(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)

        win = store.get_state(now=1500.0)["windows"][0]
        self.assertEqual(win["run_sec"], 500)
        self.assertEqual(win["idle_sec"], 500)

    def test_heartbeat_for_unknown_session_creates_running(self):
        store = StatusStore(stale_sec=600)
        store.update("s9", "heartbeat", "/tmp/a", now=1000.0)

        win = store.get_state(now=1000.0)["windows"][0]
        self.assertEqual(win["status"], "running")

    def test_new_running_resets_run_started(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s1", "running", "/tmp/a", now=1200.0)

        win = store.get_state(now=1200.0)["windows"][0]
        self.assertEqual(win["run_sec"], 0)

    def test_window_survives_within_stale_regardless_of_status(self):
        # idle 在 stale_sec 内 -> 任何状态都保留（含 running/waiting/done）
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s2", "waiting", "/tmp/b", now=1000.0)

        state = store.get_state(now=1500.0)  # idle 500 < 600
        self.assertEqual(len(state["windows"]), 2)

    def test_any_window_dropped_after_stale_fallback(self):
        # 超长无任何事件 -> 兜底清理（kill-9/关终端 残留），不论状态
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s2", "waiting", "/tmp/b", now=1000.0)

        state = store.get_state(now=2000.0)  # idle 1000 > 600
        self.assertEqual(state["windows"], [])

    def test_session_start_registers_ready_window(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "start", "/tmp/proj", now=1000.0)

        state = store.get_state(now=1000.0)
        self.assertEqual(len(state["windows"]), 1)
        self.assertEqual(state["windows"][0]["status"], "done")
        self.assertEqual(state["windows"][0]["name"], "proj")

    def test_session_end_removes_window(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/proj", now=1000.0)
        store.update("s1", "end", "/tmp/proj", now=1100.0)

        self.assertEqual(store.get_state(now=1100.0)["windows"], [])

    def test_session_end_unknown_session_is_noop(self):
        store = StatusStore(stale_sec=600)
        store.update("ghost", "end", "/tmp/proj", now=1000.0)  # 不存在也不报错

        self.assertEqual(store.get_state(now=1000.0)["windows"], [])

    def test_session_start_does_not_clobber_running(self):
        # SessionStart 可能因 resume/compact 在运行中再次触发，不能把状态降级
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/proj", now=1000.0)
        store.update("s1", "start", "/tmp/proj", now=1050.0)

        win = store.get_state(now=1050.0)["windows"][0]
        self.assertEqual(win["status"], "running")
        self.assertEqual(win["run_sec"], 50)  # run_started 未被重置


if __name__ == "__main__":
    unittest.main()
