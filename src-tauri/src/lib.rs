//! Claude Monitor 桌面悬浮窗 —— Tauri 外壳。
//!
//! 职责（界面与数据都在前端 src/ 里，用 fetch 直连本地 server）：
//! - 透明无边框置顶窗口 + Windows 毛玻璃(acrylic)
//! - 启动时确保本地 monitor server 在跑（127.0.0.1:8787），不在则原生 spawn python
//! - 托盘菜单：鼠标穿透 / 始终置顶 / 退出
//! - 记住窗口位置（tauri-plugin-window-state）、开机自启（tauri-plugin-autostart）

mod hooks;

use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

const MONITOR_PORT: u16 = 8787;

/// 外观持久化文件路径：<app_config_dir>/appearance。
fn appearance_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("appearance"))
}

/// 读取已保存的外观；非法/缺失一律回退 "pill"。
fn read_appearance(app: &tauri::AppHandle) -> String {
    appearance_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| matches!(s.as_str(), "pill" | "list" | "cat"))
        .unwrap_or_else(|| "pill".to_string())
}

/// 写入外观（尽力而为，失败不致命）。
fn write_appearance(app: &tauri::AppHandle, mode: &str) {
    if let Some(p) = appearance_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, mode);
    }
}

/// 前端启动时拉取当前外观，据此设置初始形态。
#[tauri::command]
fn get_appearance(app: tauri::AppHandle) -> String {
    read_appearance(&app)
}

/// 确保本地 monitor server 在跑（127.0.0.1:8787）：已在跑则跳过；否则原生 spawn python。
/// 关键：每一步都落日志到 monitor.log，spawn 后后台轮询 healthz —— 自启场景下 server
/// 起没起来、为什么没起来，全靠日志排查（release 是无控制台子系统，eprintln! 不可见）。
fn ensure_server(app: &tauri::App) {
    monitor_log("ensure_server: start");
    let addr: std::net::SocketAddr = format!("127.0.0.1:{MONITOR_PORT}")
        .parse()
        .expect("valid loopback addr");

    // probe 闭包用 move 自持 addr 副本（SocketAddr: Copy），便于稍后安全 move 进后台线程
    //（否则线程会在本函数返回后访问悬垂的栈上 addr）。
    let probe = move || TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok();
    if probe() {
        monitor_log("ensure_server: server already running, skip");
        return;
    }

    // server 脚本：release 取打包 resource；dev 回退项目内相对路径（cwd 通常 src-tauri/）。
    let script = app
        .path()
        .resolve("monitor_server.py", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("../server/monitor_server.py"));
    monitor_log(&format!("ensure_server: script={}", script.display()));

    // python：$MONITOR_PYTHON 覆盖（绝对路径可绕开 PATH 顺序 / WindowsApps 存根），否则默认命令。
    let py = resolve_python();
    monitor_log(&format!("ensure_server: python={py}"));

    match Command::new(&py).arg(&script).spawn() {
        Ok(child) => {
            let pid = child.id();
            monitor_log(&format!("ensure_server: spawned python pid={pid}, polling healthz"));
            // spawn 成功 ≠ server 真就绪：python 可能因存根/脚本错/端口占用立即退出。
            // 后台轮询 healthz（不阻塞窗口显示），结果落日志。
            std::thread::spawn(move || {
                if probe_retry(probe, 20, 250) {
                    // ~5s 窗口，够 python 冷启动并 bind 端口
                    monitor_log("ensure_server: healthz OK, server up");
                } else {
                    monitor_log(
                        "WARN ensure_server: spawned but healthz unreachable after ~5s. \
                         多半 python 没真正起来（WindowsApps 存根 / 脚本错 / 端口占用）。\
                         设环境变量 MONITOR_PYTHON=<绝对 python.exe 路径> 后重试。",
                    );
                }
            });
        }
        Err(e) => monitor_log(&format!(
            "WARN ensure_server: spawn python FAILED: {e}. \
             设环境变量 MONITOR_PYTHON=<绝对 python.exe 路径> 后重试。"
        )),
    }
}

/// Windows/通用用 `python`（若用 Python Launcher 可改 `py`）；
/// macOS 默认无 `python` 命令，只有 `python3`。
fn python_bin() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "python3"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "python"
    }
}

/// 选定用来拉起 server 的 python：$MONITOR_PYTHON 覆盖优先（指向绝对路径可彻底绕开
/// PATH 顺序 / WindowsApps 存根问题——存根执行会弹 Store 或立即退出，server 不起）；
/// 无覆盖则用平台默认命令名。
fn resolve_python() -> String {
    if let Some(p) = std::env::var_os("MONITOR_PYTHON") {
        return p.to_string_lossy().into_owned();
    }
    python_bin().to_string()
}

/// 最多 tries 次轮询；check 一次返回 true 即判定成功并立即停止，全部失败返回 false。
/// sleep_ms>0 时两次探测之间睡眠（生产约 250ms；测试传 0 避免拖慢）。
fn probe_retry<F: Fn() -> bool>(check: F, tries: u16, sleep_ms: u64) -> bool {
    for i in 0..tries {
        if check() {
            return true;
        }
        if sleep_ms > 0 && i + 1 < tries {
            std::thread::sleep(Duration::from_millis(sleep_ms));
        }
    }
    false
}

/// 诊断日志：追加写到 %USERPROFILE%\.claude-monitor\monitor.log。
/// release 是无控制台子系统(windows_subsystem="windows")，eprintln! 不可见 ——
/// 自启场景下 server 起没起来、为什么没起来，全靠这个文件排查。
fn monitor_log(line: &str) {
    let Some(profile) = std::env::var_os("USERPROFILE") else {
        return; // 非 Windows / 无 USERPROFILE：无处落盘，放弃（不致命）
    };
    let dir = PathBuf::from(profile).join(".claude-monitor");
    let _ = fs::create_dir_all(&dir);
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join("monitor.log"))
    {
        let _ = writeln!(f, "[{}] {}", timestamp(), line);
    }
}

/// Unix 秒时间戳（够排序定位；可读本地时间需 chrono，不为日志引入依赖）。
fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_appearance])
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("main window must exist");

            // 用纯透明窗口（不上 acrylic）：窗口按内容自适应尺寸，空白区域即桌面，
            // 圆角干净；面板/药丸自身用 CSS 半透明背景。

            // 确保后端在跑。
            ensure_server(app);

            // 确保 Windows 侧 Claude 钩子已配置（落 ps1 + 合并 settings.json）。
            // 失败不致命：只记日志，不阻断启动。
            if let Err(e) = hooks::ensure_hooks(app) {
                eprintln!("[claude-monitor] ensure_hooks skipped: {e}");
            }

            // 开机自启（幂等，重复 enable 无副作用）。
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // 托盘菜单：外观（单选） / 穿透 / 置顶 / 退出。
            let cur = read_appearance(app.handle());
            let m_pill = CheckMenuItemBuilder::with_id("mode-pill", "药丸")
                .checked(cur == "pill")
                .build(app)?;
            let m_list = CheckMenuItemBuilder::with_id("mode-list", "列表")
                .checked(cur == "list")
                .build(app)?;
            let m_cat = CheckMenuItemBuilder::with_id("mode-cat", "猫咪")
                .checked(cur == "cat")
                .build(app)?;
            let appearance_menu = SubmenuBuilder::new(app, "外观")
                .items(&[&m_pill, &m_list, &m_cat])
                .build()?;

            let passthrough = CheckMenuItemBuilder::with_id("passthrough", "鼠标穿透")
                .checked(false)
                .build(app)?;
            let ontop = CheckMenuItemBuilder::with_id("ontop", "始终置顶")
                .checked(true)
                .build(app)?;
            let rehook = MenuItemBuilder::with_id("rehook", "重配 Claude 钩子").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&appearance_menu, &passthrough, &ontop, &rehook, &quit])
                .build()?;

            let win_for_menu = win.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude Monitor")
                .menu(&menu)
                .on_menu_event(move |app_handle, event| {
                    // 外观单选：选中目标项、互斥取消其余、持久化、通知前端切形态。
                    let set_mode = |mode: &str| {
                        let _ = m_pill.set_checked(mode == "pill");
                        let _ = m_list.set_checked(mode == "list");
                        let _ = m_cat.set_checked(mode == "cat");
                        write_appearance(app_handle, mode);
                        let _ = win_for_menu.emit("set-mode", mode);
                    };
                    match event.id().as_ref() {
                        "mode-pill" => set_mode("pill"),
                        "mode-list" => set_mode("list"),
                        "mode-cat" => set_mode("cat"),
                        "passthrough" => {
                            // CheckMenuItem 点击后状态已翻转，读取最新值。
                            let on = passthrough.is_checked().unwrap_or(false);
                            let _ = win_for_menu.set_ignore_cursor_events(on);
                            // 通知前端：穿透时降低不透明度作视觉提示。
                            let _ = win_for_menu.emit("passthrough", on);
                        }
                        "ontop" => {
                            let on = ontop.is_checked().unwrap_or(true);
                            let _ = win_for_menu.set_always_on_top(on);
                        }
                        "rehook" => {
                            // 手动重试落脚本 + 合并 settings.json，并通知前端 toast 反馈。
                            let ok = hooks::ensure_hooks(app_handle).is_ok();
                            let _ = win_for_menu.emit("hooks-configured", ok);
                        }
                        "quit" => app_handle.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // resolve_python：env MONITOR_PYTHON 覆盖优先（用户可指向绝对路径，绕开 PATH/存根问题）。
    #[test]
    fn resolve_python_prefers_env_override() {
        std::env::set_var("MONITOR_PYTHON", r"C:\some\python.exe");
        assert_eq!(resolve_python(), r"C:\some\python.exe");
        std::env::remove_var("MONITOR_PYTHON");
    }

    #[test]
    fn resolve_python_defaults_when_no_env() {
        std::env::remove_var("MONITOR_PYTHON");
        let got = resolve_python();
        #[cfg(target_os = "macos")]
        {
            assert_eq!(got, "python3");
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(got, "python");
        }
    }

    // probe_retry：轮询判定健康，命中即停、耗尽即弃。
    #[test]
    fn probe_retry_true_when_first_check_succeeds() {
        assert!(probe_retry(|| true, 3, 0));
    }

    #[test]
    fn probe_retry_false_when_all_attempts_fail() {
        assert!(!probe_retry(|| false, 3, 0));
    }

    #[test]
    fn probe_retry_succeeds_on_nth_attempt_and_stops() {
        let count = AtomicUsize::new(0);
        let ok = probe_retry(
            || count.fetch_add(1, Ordering::SeqCst) >= 1, // 第 2 次起 true
            5,
            0,
        );
        assert!(ok);
        assert_eq!(count.load(Ordering::SeqCst), 2); // 命中即停，不浪费
    }

    // monitor_log：追加写到 %USERPROFILE%\.claude-monitor\monitor.log。
    #[test]
    fn monitor_log_appends_under_userprofile() {
        let tmp = std::env::temp_dir().join(format!("cm-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("USERPROFILE", &tmp);
        monitor_log("line-one");
        monitor_log("line-two");
        let content =
            std::fs::read_to_string(tmp.join(".claude-monitor").join("monitor.log")).unwrap();
        assert!(content.contains("line-one"));
        assert!(content.contains("line-two"));
        std::env::remove_var("USERPROFILE");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
