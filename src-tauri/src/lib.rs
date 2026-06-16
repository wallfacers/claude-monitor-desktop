//! Claude Monitor 桌面悬浮窗 —— Tauri 外壳。
//!
//! 职责（界面与数据都在前端 src/ 里，用 fetch 直连本地 server）：
//! - 透明无边框置顶窗口 + Windows 毛玻璃(acrylic)
//! - 启动时确保本地 monitor server 在跑（127.0.0.1:8787），不在则原生 spawn python
//! - 托盘菜单：鼠标穿透 / 始终置顶 / 退出
//! - 记住窗口位置（tauri-plugin-window-state）、开机自启（tauri-plugin-autostart）

use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

const MONITOR_PORT: u16 = 8787;

/// 端口已监听则认为 server 已在跑；否则原生 spawn python 拉起。
/// 同机原生子进程，不随会话回收（不同于 wsl.exe 后台进程）。
fn ensure_server(app: &tauri::App) {
    if TcpStream::connect_timeout(
        &(format!("127.0.0.1:{MONITOR_PORT}").parse().unwrap()),
        Duration::from_millis(300),
    )
    .is_ok()
    {
        return;
    }

    // release: 取打包进资源目录的 monitor_server.py；dev: 回退到项目内相对路径。
    let bundled = app
        .path()
        .resolve("monitor_server.py", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());

    let mut cmd = Command::new(python_bin());
    match bundled {
        Some(path) => {
            cmd.arg(path);
        }
        None => {
            // dev 下 cwd 通常是 src-tauri/，server 在上一级
            cmd.arg("../server/monitor_server.py");
        }
    }
    let _ = cmd.spawn(); // 失败不致命：前端会显示「离线」，用户也可手动起 server
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

            // 开机自启（幂等，重复 enable 无副作用）。
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // 托盘菜单：穿透 / 置顶 / 退出。
            let passthrough = CheckMenuItemBuilder::with_id("passthrough", "鼠标穿透")
                .checked(false)
                .build(app)?;
            let ontop = CheckMenuItemBuilder::with_id("ontop", "始终置顶")
                .checked(true)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&passthrough, &ontop, &quit])
                .build()?;

            let win_for_menu = win.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude Monitor")
                .menu(&menu)
                .on_menu_event(move |app_handle, event| match event.id().as_ref() {
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
                    "quit" => app_handle.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
