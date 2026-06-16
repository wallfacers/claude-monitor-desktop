# Windows 侧交接说明（Phase C/D）

本文件给在 **Windows 原生环境**（非 WSL）用 Claude Code 继续本项目的你。
WSL/Linux 侧已完成 **Phase A（后端）+ Phase B（前端纯逻辑）+ 前端静态文件**，全部测试通过。
剩下 **Phase C/D**（Tauri 外壳、托盘/穿透/自启、拉起后端、打包）需要 Windows 工具链，在这里完成。

完整任务原文见 `docs/superpowers/plans/2026-06-16-claude-monitor-desktop.md`；设计见
`docs/superpowers/specs/2026-06-16-claude-monitor-desktop-design.md`。本文件把 C/D 的占位都填成了实值。

## 已知环境实值（填入命令时直接用）

- WSL 发行版名：`Ubuntu`
- 后端 server 绝对路径（WSL 内）：`/home/wushengzhou/workspace/github/claude-monitor/server/monitor_server.py`
- 后端 hook 脚本（WSL 内）：`/home/wushengzhou/workspace/github/claude-monitor/hooks/report-status.sh`
- python 解释器（WSL 内）：`python3`（已验证 3.13 可跑，零三方依赖）
- 服务地址：WSL 内监听 `127.0.0.1:8787`，Windows 经 WSL2 localhost 转发用 `http://localhost:8787` 访问
- 本项目位置（Windows）：`D:\project\java\source\claude-monitor-desktop`

## 已完成（不要重复造）

- `src/render.js`：纯逻辑 `formatDuration` / `buildViewModel` / `newlyWaiting` / `statusLabel`（已单测）
- `src/render.test.js`：`npm test` → 12/12 通过（`node --test src/*.test.js`）
- `src/index.html` / `src/styles.css` / `src/app.js` / `src/ding.mp3`(占位空文件)
- `package.json`（type module；test 脚本已就绪）

## 前置安装（Windows）

- Node ≥ 18（验证：`node --version`）
- Rust 工具链 `rustup`（验证：`cargo --version`）
- WebView2 Runtime（Win10/11 多已自带）
- 验证已完成的前端逻辑：在项目根 `npm test`，应 12/12 通过

---

## Task C1：脚手架 Tauri v2，接入已有 `src/`

> Tauri v2 的精确 API/字段以脚手架生成版本为准；下面给关键改动点，若字段名因版本不同以
> `npm run tauri` 报错为准微调。

1. 在项目根生成脚手架到临时目录（**不要覆盖现有 `src/`**）：
   ```powershell
   npm create tauri-app@latest tauri-tmp -- --template vanilla --manager npm --yes
   ```
2. 把 `tauri-tmp\src-tauri` 移到项目根；合并 `package.json` 的 scripts/deps（保留我们自己的 `src/` 与 test 脚本）：
   ```powershell
   Move-Item tauri-tmp\src-tauri .\src-tauri
   # 合并 package.json：保留我们的 scripts.test，纳入 tauri 的 scripts/deps
   node -e "const a=require('./tauri-tmp/package.json'),b=require('./package.json');b.scripts=Object.assign({},a.scripts,b.scripts);b.devDependencies=Object.assign({},a.devDependencies,b.devDependencies);b.dependencies=Object.assign({},a.dependencies,b.dependencies);require('fs').writeFileSync('./package.json',JSON.stringify(b,null,2))"
   Remove-Item -Recurse -Force tauri-tmp
   npm install
   ```
3. 让 Tauri 用我们的静态前端：编辑 `src-tauri/tauri.conf.json` 的 `build` 段：
   ```json
   "build": {
     "frontendDist": "../src",
     "devUrl": null,
     "beforeDevCommand": "",
     "beforeBuildCommand": ""
   }
   ```
4. 验证编译链：`npm run tauri dev` 能弹出窗口（可能显示我们的悬浮窗 UI）；Ctrl+C 退出。
5. 提交：`git add -A && git commit -m "chore(desktop): scaffold Tauri v2 shell pointing at src/"`

## Task C4：窗口属性 + 毛玻璃 + 记住位置

1. `src-tauri/tauri.conf.json` 主窗口（`app.windows[0]`）设：
   ```json
   { "label": "main", "width": 320, "height": 360, "decorations": false,
     "transparent": true, "alwaysOnTop": true, "skipTaskbar": true,
     "resizable": false, "shadow": false }
   ```
2. `src-tauri/Cargo.toml` `[dependencies]` 加：
   ```toml
   window-vibrancy = "0.5"
   tauri-plugin-window-state = "2"
   ```
3. `src-tauri/src/main.rs` 的 `setup` 回调里：
   ```rust
   use tauri::Manager;
   use window_vibrancy::apply_acrylic;

   let win = app.get_webview_window("main").unwrap();
   let _ = apply_acrylic(&win, Some((18, 21, 28, 160))); // 不支持则忽略，回退 CSS 半透明
   ```
   并在 builder 链上加窗口状态插件（自动持久化/恢复位置）：
   ```rust
   .plugin(tauri_plugin_window_state::Builder::default().build())
   ```
4. 验证：`npm run tauri dev` → 无边框、透明可见桌面、置顶、任务栏无图标；拖动后关闭重开位置保持。
5. 把真实短提示音覆盖到 `src/ding.mp3`（替换占位空文件）。
6. 提交。

## Task C5：托盘菜单（穿透/置顶/退出）+ 开机自启

1. `src-tauri/Cargo.toml` `[dependencies]` 加：`tauri-plugin-autostart = "2"`
2. `src-tauri/src/main.rs` 注册托盘（Tauri v2 `TrayIconBuilder`+`MenuBuilder`）：
   ```rust
   use tauri::{ menu::{MenuBuilder, MenuItemBuilder, CheckMenuItemBuilder},
               tray::TrayIconBuilder, Manager };

   let passthrough = CheckMenuItemBuilder::new("鼠标穿透").id("passthrough").checked(false).build(app)?;
   let ontop = CheckMenuItemBuilder::new("始终置顶").id("ontop").checked(true).build(app)?;
   let quit = MenuItemBuilder::new("退出").id("quit").build(app)?;
   let menu = MenuBuilder::new(app).items(&[&passthrough, &ontop, &quit]).build()?;

   let _tray = TrayIconBuilder::new()
       .menu(&menu)
       .on_menu_event(move |app, event| {
           let win = app.get_webview_window("main").unwrap();
           match event.id().as_ref() {
               "passthrough" => {
                   let on = passthrough.is_checked().unwrap_or(false);
                   let _ = win.set_ignore_cursor_events(on);
                   let _ = win.emit("passthrough", on);
               }
               "ontop" => {
                   let on = ontop.is_checked().unwrap_or(true);
                   let _ = win.set_always_on_top(on);
               }
               "quit" => app.exit(0),
               _ => {}
           }
       })
       .build(app)?;
   ```
3. 前端 `src/app.js` 末尾加 passthrough 淡显监听（需 `npm i @tauri-apps/api`）：
   ```js
   import { listen } from "@tauri-apps/api/event";
   listen("passthrough", (e) => {
     document.documentElement.style.opacity = e.payload ? "0.6" : "1";
   });
   ```
   （注意：加 import 后 `app.js` 依赖 Tauri 运行时，`node --check` 仍可过，但浏览器直开会报模块缺失——只在 Tauri 内运行。）
4. 开机自启：builder 上加插件并首启启用一次：
   ```rust
   .plugin(tauri_plugin_autostart::init(
       tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
   ```
   `setup` 中：
   ```rust
   use tauri_plugin_autostart::ManagerExt;
   let _ = app.autolaunch().enable();
   ```
5. 验证：托盘出现；穿透切换后点击穿过悬浮窗、窗口变淡；置顶可切；退出可用；（打包安装后验证开机自启更准）。
6. 提交。

## Task D1：启动时确保 WSL 后端在跑（healthz 探测 + wsl.exe 拉起）

在 `src-tauri/src/main.rs` 的 `setup` 中加（路径/发行版已是实值）：

```rust
use std::process::Command;

let healthy = std::net::TcpStream::connect(("127.0.0.1", 8787)).is_ok();
if !healthy {
    let _ = Command::new("wsl.exe")
        .args([
            "-d", "Ubuntu",
            "--", "bash", "-lc",
            "nohup python3 /home/wushengzhou/workspace/github/claude-monitor/server/monitor_server.py >/tmp/monitor.log 2>&1 &",
        ])
        .spawn();
}
```
（用 std `TcpStream` 探端口，零额外依赖；若想探 `/healthz` HTTP 可改用 `reqwest` blocking。）

验证：先在 WSL 里 `pkill -f monitor_server.py` 确保未运行 → 启动桌面应用 → 数秒后悬浮窗从「离线」恢复正常 → WSL 内 `cat /tmp/monitor.log` 有启动日志。提交。

## Task D2：打包 + README

1. `npm run tauri build` → 产物在 `src-tauri/target/release/bundle/`（.msi/.exe）。
2. 端到端验证一轮：安装 → 开机自启 → 在 WSL 真跑一个 Claude Code 任务 → 悬浮窗显示该窗口 running 计时增长 →
   触发权限确认变 waiting 高亮+声音+展开 → 任务结束变 done。
3. 写 `README.md`（架构一句话、依赖、`npm run tauri dev/build`、托盘说明、`/state` 契约、待核实项现状）。提交。

---

## ⚠️ 还需在 WSL 侧做的一步：配置 hooks（否则后端收不到事件）

桌面应用只是展示层。要让 Claude Code 把状态报上来，必须在 **WSL 的 `~/.claude/settings.json`** 的
`hooks` 块里**合并**（不要覆盖已有的 `ConfigChange` 等）下面四个 hook，命令用绝对路径：

```json
{
  "hooks": {
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "/home/wushengzhou/workspace/github/claude-monitor/hooks/report-status.sh" } ] } ],
    "PostToolUse":      [ { "hooks": [ { "type": "command", "command": "/home/wushengzhou/workspace/github/claude-monitor/hooks/report-status.sh" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "command", "command": "/home/wushengzhou/workspace/github/claude-monitor/hooks/report-status.sh" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "/home/wushengzhou/workspace/github/claude-monitor/hooks/report-status.sh" } ] } ]
  }
}
```

配在用户级 settings 对所有窗口、所有模型后端生效。脚本任何失败都静默 `exit 0`，不阻塞 Claude Code。

## 待核实项（实测时确认）

1. WSL2 localhost 转发对 `127.0.0.1:8787` 是否稳：若 Windows 连不上，可让 server 改绑 `0.0.0.0`
   （`MONITOR_HOST=0.0.0.0 python3 .../monitor_server.py`）并改用 WSL IP，或排查 `.wslconfig` 的
   `localhostForwarding`。
2. acrylic/mica 在本机 Windows 版本上的可用性与回退表现。
3. `PostToolUse` hook 的 stdin 是否含 `session_id`/`cwd`（与其它事件一致）——已假设一致；若不一致，
   心跳的窗口归属需调整。
