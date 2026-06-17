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
use std::time::Duration;

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
