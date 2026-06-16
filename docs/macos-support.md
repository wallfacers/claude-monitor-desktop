# macOS 支持评估

结论：**理论可行，工作量小**。Tauri 本身跨平台，本项目大部分已平台无关；macOS 只差几处适配。当前标记为 **🚧 实验性**——代码已留好接口，但尚未在真机 Mac 上编译/验证。

主力平台是 **Windows**。**Linux 不支持**（不投入）。

## 现状盘点

| 模块 | 跨平台性 | 说明 |
|---|---|---|
| `server/monitor_server.py` | ✅ 完全通用 | 纯 Python 标准库，Mac/Win 一致 |
| `hooks/report-status.sh` | ✅ 通用 | bash，macOS 直接可用 |
| `hooks/report-status.ps1` | ⚠️ 仅 Windows | macOS 用 `.sh` 版即可，无需 ps1 |
| 前端 `src/` | ✅ 通用 | WebView 渲染，逻辑无平台依赖 |
| `tauri-plugin-autostart` | ✅ 已配 macOS | `MacosLauncher::LaunchAgent` 已就位 |
| `tauri-plugin-window-state` | ✅ 通用 | 记住位置跨平台 |
| 托盘 / 透明 / 置顶 | ✅ 通用 | Tauri 抽象，行为略有差异（见下）|

## 已做的安全适配（对 Windows 零影响）

1. **`python_bin()` 跨平台**（`src-tauri/src/lib.rs`）：macOS 返回 `python3`（Mac 默认无 `python` 命令），其它平台仍 `python`。用 `#[cfg(target_os)]` 编译期分支。
2. **`macOSPrivateApi: true`**（`tauri.conf.json`）：macOS 透明窗口**必须**开启此项才能真正透明（用到私有 API）。该字段在 Windows 上被忽略。

## 在 Mac 上跑起来还需要做的（待真机验证时补）

1. **隐藏 Dock 图标**：悬浮小工具不该占 Dock。在 `setup()` 里加（仅 macOS 编译）：
   ```rust
   #[cfg(target_os = "macos")]
   app.set_activation_policy(tauri::ActivationPolicy::Accessory);
   ```
   > 注意：`Accessory` 模式下应用不进 Dock、也不抢焦点，正适合常驻悬浮窗。`skipTaskbar` 在 macOS 上不等价于此，需要这行。

2. **托盘图标**：macOS 菜单栏图标建议用「模板图（template image）」单色 PNG，否则在深/浅色菜单栏显示不佳。需准备一张 `iconTemplate.png`。

3. **（可选）原生毛玻璃**：想要 macOS 风格磨砂，可引入 `window-vibrancy` 的 `NSVisualEffectMaterial`（仅 macOS）。当前 CSS 半透明已够用，非必需。

4. **构建必须在 macOS 上进行**：`npm run tauri build` 只为宿主系统产出包。Mac 上会得到 `.app` / `.dmg`（`bundle.targets: "all"` 已覆盖）。无法在 Windows/WSL 交叉编译 macOS 包。

5. **签名/公证**：仅自用可跳过；若分发给他人需 Apple 开发者签名 + 公证，否则 Gatekeeper 拦截。`macOSPrivateApi` 用了私有 API，**无法上架 Mac App Store**（自用无影响）。

## 工作量估计

留好接口后，真机适配约 **0.5–1 天**：加 activation policy、做模板图标、跑通 `tauri build`、验证透明/置顶/穿透/托盘几个交互。无架构改动。

## 为什么不支持 Linux

桌面环境碎片化（X11/Wayland、各家合成器对透明/置顶/穿透支持不一），验证成本高而收益低。需求侧只用 Windows，故不投入。
