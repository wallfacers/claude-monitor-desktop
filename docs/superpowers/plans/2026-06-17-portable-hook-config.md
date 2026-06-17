# 钩子配置可移植化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 侧 Claude Code 钩子配置开箱即用且路径可移植——应用启动时自动把 `report-status.ps1` 落到固定用户目录 `%USERPROFILE%\.claude-monitor\`,并幂等合并 `~/.claude/settings.json`,用户下载安装后无需手动改任何路径。

**Architecture:** 新增 `src-tauri/src/hooks.rs`。核心是纯函数 `merge_hooks`(幂等合并 6 个事件、迁移旧写死路径、保留已有配置),IO 层 `install_ps1`/`ensure_hooks` 落脚本到固定目录并写 `settings.json`(带 `.monitorbak` 备份)。`setup()` 启动自动调一次,托盘菜单「重配 Claude 钩子」可手动重试并 toast 反馈。ps1 打包进 `tauri.conf.json` 的 resources。

**Tech Stack:** Rust + Tauri v2(`Manager` / `path::BaseDirectory`)、`serde_json`、`std::fs`;前端 vanilla JS(`window.__TAURI__.event`);测试 `cargo test`。

**Spec:** `docs/superpowers/specs/2026-06-17-portable-hook-config-design.md`

---

## File Structure

- **Create** `src-tauri/src/hooks.rs` — 钩子自动配置全部逻辑。纯函数 `merge_hooks`(可单测)+ IO 函数(`install_ps1` / `ensure_hooks`)。单一职责:把「让 Windows 侧 claude 上报」这件事做完。
- **Modify** `src-tauri/src/lib.rs` — `mod hooks;`;`setup()` 启动调 `ensure_hooks`;托盘菜单加「重配 Claude 钩子」项。
- **Modify** `src-tauri/tauri.conf.json` — `bundle.resources` 增加 ps1。
- **Modify** `src/app.js` — 监听 `hooks-configured` 事件,toast 反馈。
- **Modify** `HANDOFF-WINDOWS.md` / `README.md` — 说明自动配置。

依赖确认(`src-tauri/Cargo.toml` 已含,无需新增):`serde`/`serde_json`/`tauri`(`macos-private-api`+`tray-icon` features)。

---

## Task 1: `hooks.rs` 纯函数 `merge_hooks`(TDD)

**Files:**
- Create: `src-tauri/src/hooks.rs`
- Modify: `src-tauri/src/lib.rs`(顶部加 `mod hooks;`)

- [ ] **Step 1: 写 hooks.rs(先只有测试,函数未实现 → 编译失败即「红」)**

创建 `src-tauri/src/hooks.rs`,内容:

```rust
//! Windows 侧 Claude Code 钩子自动配置：落脚本 + 幂等合并 settings.json。
//!
//! 设计原则（与 ensure_server 一致）：任何失败都不阻断应用启动，最坏情况
//! 只是 Windows 侧 claude 不上报，应用本身照常运行。

use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;

    // 预期 command 字符串（与实现里的 command_for 完全一致）。
    fn cmd(path: &str) -> String {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            path
        )
    }

    const PS1: &str = r"C:\Users\me\.claude-monitor\report-status.ps1";

    #[test]
    fn empty_settings_adds_all_six_events() {
        let out = merge_hooks(json!({}), PS1);
        let hooks = out.get("hooks").expect("hooks present");
        for ev in [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "Notification",
            "Stop",
            "SessionEnd",
        ] {
            let arr = hooks.get(ev).unwrap().as_array().unwrap();
            assert_eq!(arr.len(), 1, "{ev} should have exactly one block");
            assert_eq!(
                arr[0]["hooks"][0]["command"].as_str().unwrap(),
                cmd(PS1)
            );
        }
    }

    #[test]
    fn preserves_unrelated_hooks_and_top_level_fields() {
        let existing = json!({
            "model": "claude-x",
            "hooks": {
                "PreToolUse": [
                    { "hooks": [ { "type": "command", "command": "echo hi" } ] }
                ],
                "Stop": [
                    { "hooks": [ { "type": "command", "command": "echo keep" } ] }
                ]
            }
        });
        let out = merge_hooks(existing, PS1);
        // 顶层无关字段保留
        assert_eq!(out["model"], "claude-x");
        // 无关事件 command 原样保留
        assert_eq!(
            out["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap(),
            "echo hi"
        );
        // Stop 里已有非本应用 hook(echo keep)：保留它，并追加本应用条目
        let stop = out["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"].as_str().unwrap(), "echo keep");
        assert_eq!(stop[1]["hooks"][0]["command"].as_str().unwrap(), cmd(PS1));
    }

    #[test]
    fn migrates_legacy_hardcoded_path() {
        let legacy = format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            r"D:\develop\java\source\claude-monitor-desktop\hooks\report-status.ps1"
        );
        let existing = json!({
            "hooks": {
                "SessionStart": [
                    { "hooks": [ { "type": "command", "command": legacy } ] }
                ]
            }
        });
        let out = merge_hooks(existing, PS1);
        // 迁移而非追加：仍是 1 条，但 command 已换成新固定路径
        let arr = out["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"].as_str().unwrap(), cmd(PS1));
    }

    #[test]
    fn idempotent_when_already_configured() {
        let once = merge_hooks(json!({}), PS1);
        let twice = merge_hooks(once.clone(), PS1);
        for ev in [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "Notification",
            "Stop",
            "SessionEnd",
        ] {
            let a = once["hooks"][ev].as_array().unwrap();
            let b = twice["hooks"][ev].as_array().unwrap();
            assert_eq!(a.len(), 1);
            assert_eq!(b.len(), 1, "{ev} must not duplicate on re-run");
            assert_eq!(a[0], b[0]);
        }
    }

    #[test]
    fn corrupt_non_object_input_degrades_to_clean() {
        // 数组（非对象）→ 降级为只含 6 事件的合法结构，不 panic
        let out = merge_hooks(json!([1, 2, 3]), PS1);
        assert!(out.is_object());
        assert!(out["hooks"].is_object());
        for ev in [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "Notification",
            "Stop",
            "SessionEnd",
        ] {
            assert_eq!(out["hooks"][ev].as_array().unwrap().len(), 1);
        }
    }
}
```

在 `src-tauri/src/lib.rs` 第 1 行(`//!` 文档注释)之后、`use std::net::TcpStream;` 之前插入:

```rust
mod hooks;
```

- [ ] **Step 2: 运行测试,确认它失败(编译失败 = 红)**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 编译失败,错误信息形如 `cannot find function 'merge_hooks' in this scope`。

- [ ] **Step 3: 实现 `merge_hooks` + 常量 + `command_for`**

在 `src-tauri/src/hooks.rs` 顶部(`use serde_json::{json, Value};` 之后、`#[cfg(test)]` 之前)插入:

```rust
/// 6 个目标事件：Claude Code 生命周期钩子。
const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Notification",
    "Stop",
    "SessionEnd",
];

/// 识别「本应用 hook」的标记：command 含脚本名即视为本应用条目（含旧写死路径）。
const SCRIPT_MARKER: &str = "report-status.ps1";

/// 生成写入 settings.json 的 command 字符串。
fn command_for(ps1_path: &str) -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        ps1_path
    )
}

/// 幂等合并：确保 6 个目标事件存在且 command 指向 ps1_path；
/// 含旧写死路径的本应用条目会被迁移成新固定路径；保留所有其他配置。
/// existing 非对象（含损坏/null）降级为空对象。
pub fn merge_hooks(existing: Value, ps1_path: &str) -> Value {
    let mut root = if existing.is_object() {
        existing
    } else {
        json!({})
    };
    let target = command_for(ps1_path);
    let obj = root.as_object_mut().expect("root is object after coerce");

    let hooks = obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    for ev in HOOK_EVENTS {
        let arr = hooks_obj.entry((*ev).to_string()).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let events = arr.as_array_mut().unwrap();

        // 遍历该事件的 hooks 列表，更新已存在的本应用条目；没有则追加。
        let mut found_ours = false;
        for block in events.iter_mut() {
            // block 形如 { "hooks": [ { "type":"command", "command":"..." } ] }
            if let Some(inner) = block.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                for hook in inner.iter_mut() {
                    let is_ours = hook
                        .get("command")
                        .and_then(|c| c.as_str())
                        .map(|s| s.contains(SCRIPT_MARKER))
                        .unwrap_or(false);
                    if is_ours {
                        if let Some(ho) = hook.as_object_mut() {
                            ho.insert("type".to_string(), json!("command"));
                            ho.insert("command".to_string(), json!(target.clone()));
                        }
                        found_ours = true;
                    }
                }
            }
        }
        if !found_ours {
            events.push(json!({ "hooks": [ { "type": "command", "command": target.clone() } ] }));
        }
    }
    root
}
```

- [ ] **Step 4: 运行测试,确认通过(绿)**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: `test result: ok. 5 passed`(5 个测试全绿)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks.rs src-tauri/src/lib.rs
git commit -m "feat(hooks): 幂等合并 settings.json 的纯函数 merge_hooks + 单测"
```

---

## Task 2: IO 层 —— 落脚本 + 合并 settings.json(`ensure_hooks`)

**Files:**
- Modify: `src-tauri/src/hooks.rs`(顶部 use 补全 + 在 `merge_hooks` 后插入 IO 函数)

- [ ] **Step 1: 补全 use 声明**

把 `src-tauri/src/hooks.rs` 顶部的 use 块从:

```rust
use serde_json::{json, Value};
```

改为:

```rust
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{path::BaseDirectory, Manager};
```

- [ ] **Step 2: 在 `merge_hooks` 之后、`#[cfg(test)]` 之前插入 IO 函数**

```rust
fn user_profile() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// 固定落点：%USERPROFILE%\.claude-monitor\report-status.ps1
fn target_ps1_path() -> Option<PathBuf> {
    Some(user_profile()?.join(".claude-monitor").join("report-status.ps1"))
}

/// %USERPROFILE%\.claude\settings.json
fn claude_settings_path() -> Option<PathBuf> {
    Some(user_profile()?.join(".claude").join("settings.json"))
}

/// release：resources 内 hooks/report-status.ps1；dev：回退 ../hooks/report-status.ps1。
fn packed_ps1_source<M: Manager>(app: &M) -> Option<PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("hooks/report-status.ps1", BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p);
        }
    }
    // dev：cwd 通常是 src-tauri/，hooks 在上一级。
    let dev = PathBuf::from("../hooks/report-status.ps1");
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// 落脚本到固定用户目录（目录不存在则建；内容一致则跳过，变了则覆盖）。
fn install_ps1<M: Manager>(app: &M) -> Option<PathBuf> {
    let dst = target_ps1_path()?;
    let src = packed_ps1_source(app)?;
    if let Some(dir) = dst.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let need_copy = match (fs::read(&dst), fs::read(&src)) {
        (Ok(a), Ok(b)) => a != b,
        _ => true, // 目标不存在或读失败 → 拷
    };
    if need_copy {
        let _ = fs::copy(&src, &dst);
    }
    Some(dst)
}

/// 落脚本 + 幂等合并 settings.json。失败返回 Err（不 panic）。
pub fn ensure_hooks<M: Manager>(app: &M) -> Result<(), String> {
    let dst = install_ps1(app)
        .ok_or_else(|| "无法定位 USERPROFILE 或 ps1 源".to_string())?;
    // Windows command 行用反斜杠
    let ps1_str = dst.to_string_lossy().replace('/', "\\");

    let settings = claude_settings_path()
        .ok_or_else(|| "无法定位 USERPROFILE".to_string())?;

    // 读：不存在/损坏 → {}。
    let raw = fs::read_to_string(&settings).unwrap_or_else(|_| "{}".to_string());
    let existing: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));

    // 备份原始内容（即便损坏也存一份，防丢失）。
    let _ = fs::write(settings.with_extension("json.monitorbak"), &raw);

    let merged = merge_hooks(existing, &ps1_str);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    fs::write(&settings, out).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: 编译确认类型/路径 API 正确**

Run:
```bash
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: 编译成功(`Finished`)。若报 `app.path()` 相关错误,确认 `use tauri::Manager;` 已在 Step 1 补上。

- [ ] **Step 4: 再次跑测试确认未破坏纯函数测试**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 5 passed(仍绿)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks.rs
git commit -m "feat(hooks): ensure_hooks 落脚本到固定目录 + 合并 settings.json(带备份)"
```

---

## Task 3: `setup()` 启动时自动配置

**Files:**
- Modify: `src-tauri/src/lib.rs`(setup 闭包内,`ensure_server(app)` 之后)

- [ ] **Step 1: 在 `ensure_server(app);` 之后插入自动配置调用**

找到 `lib.rs` 里的:

```rust
            // 确保后端在跑。
            ensure_server(app);
```

在其后插入:

```rust

            // 确保 Windows 侧 Claude 钩子已配置（落 ps1 + 合并 settings.json）。
            // 失败不致命：只记日志，不阻断启动。
            if let Err(e) = hooks::ensure_hooks(app) {
                eprintln!("[claude-monitor] ensure_hooks skipped: {e}");
            }
```

- [ ] **Step 2: 编译确认**

Run:
```bash
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: `Finished`。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(setup): 启动时自动配置 Windows 侧 Claude 钩子"
```

---

## Task 4: 托盘菜单「重配 Claude 钩子」

**Files:**
- Modify: `src-tauri/src/lib.rs`(菜单构建 + `on_menu_event` 分支)

- [ ] **Step 1: 新增菜单项**

找到 `lib.rs` 里:

```rust
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&passthrough, &ontop, &quit])
                .build()?;
```

替换为:

```rust
            let rehook = MenuItemBuilder::with_id("rehook", "重配 Claude 钩子").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&passthrough, &ontop, &rehook, &quit])
                .build()?;
```

- [ ] **Step 2: 在 `on_menu_event` 的 match 里加 `rehook` 分支**

找到 `lib.rs` 里 `on_menu_event` 的 match,有 `"ontop" => { ... }` 和 `"quit" => ...`。在 `"ontop"` 分支之后、`"quit"` 之前插入:

```rust
                    "rehook" => {
                        // 手动重试落脚本 + 合并 settings.json，并通知前端 toast 反馈。
                        let ok = hooks::ensure_hooks(app_handle).is_ok();
                        let _ = win_for_menu.emit("hooks-configured", ok);
                    }
```

- [ ] **Step 3: 编译确认**

Run:
```bash
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: `Finished`。(`Emitter` 已在 lib.rs 顶部 `use tauri::{..., Emitter, Manager}` 中,无需新增。)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): 加「重配 Claude 钩子」菜单项 + toast 反馈"
```

---

## Task 5: ps1 打包进 tauri resources

**Files:**
- Modify: `src-tauri/tauri.conf.json`(`bundle.resources`)

- [ ] **Step 1: resources 增加 ps1**

把 `tauri.conf.json` 的:

```json
    "resources": {
      "../server/monitor_server.py": "monitor_server.py"
    },
```

替换为:

```json
    "resources": {
      "../server/monitor_server.py": "monitor_server.py",
      "../hooks/report-status.ps1": "hooks/report-status.ps1"
    },
```

- [ ] **Step 2: 验证 JSON 合法**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build(tauri): 把 report-status.ps1 打包进 resources"
```

---

## Task 6: 前端 toast 反馈

**Files:**
- Modify: `src/app.js`(末尾 Tauri 事件监听块旁)

- [ ] **Step 1: 加 `hooks-configured` 监听 + 轻量 toast**

找到 `app.js` 末尾:

```js
// Tauri 事件：鼠标穿透开启时降低不透明度作视觉提示。
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("passthrough", (e) => {
    document.documentElement.style.opacity = e.payload ? "0.55" : "1";
  });
}
```

在其后追加:

```js

// 托盘「重配 Claude 钩子」结果反馈：短暂浮窗（内联样式，不依赖 CSS 文件）。
function flashHookToast(ok) {
  let t = document.getElementById("hookToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "hookToast";
    t.style.cssText =
      "position:fixed;left:50%;bottom:6px;transform:translateX(-50%);" +
      "padding:3px 8px;border-radius:6px;font-size:12px;z-index:99;" +
      "background:rgba(40,40,40,.9);color:#fff;pointer-events:none;" +
      "opacity:0;transition:opacity .2s";
    document.body.appendChild(t);
  }
  t.textContent = ok ? "✅ Claude 钩子已配置" : "⚠️ 钩子配置失败（见日志）";
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.opacity = "0"), 2000);
}
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("hooks-configured", (e) => flashHookToast(e.payload));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app.js
git commit -m "feat(ui): 重配钩子结果 toast 反馈"
```

---

## Task 7: 文档更新

**Files:**
- Modify: `HANDOFF-WINDOWS.md`、`README.md`

- [ ] **Step 1: HANDOFF「手动配 hooks」段改为说明自动配置**

找到 `HANDOFF-WINDOWS.md` 中以 `## 让 Windows 侧的 Claude Code 也计数` 开头的整段(从该标题到「配好后重启 claude 窗口加载新 hooks。……」)。把该标题下一行起的引言改为自动配置说明:

将该标题下的第一段(以 `WSL 的 claude 已上报。Windows 的 claude 要单独配 hooks,用 `hooks/report-status.ps1`。` 开头的那段)替换为:

```markdown
应用**首次启动即自动完成** Windows 侧钩子配置：把 `report-status.ps1` 落到固定目录 `%USERPROFILE%\.claude-monitor\`,并幂等合并进 `%USERPROFILE%\.claude\settings.json`(写前备份为 `settings.json.monitorbak`,保留你已有的其他 hooks;旧写死路径会被自动迁移)。**无需手动改任何路径**，换机/搬家/重装都不影响。

若 claude 未上报，点托盘**「重配 Claude 钩子」**手动重试(右下角会有 toast 反馈)。

<details><summary>手动/排查参考(旧写死路径版,已不再需要)</summary>

WSL 的 claude 已上报。Windows 的 claude 历史上需要手动在 `%USERPROFILE%\.claude\settings.json` 的 `hooks` 块合并六个事件指向 ps1;现由应用启动自动完成。若需手动核对/排查,六个事件指向固定路径 `%USERPROFILE%\.claude-monitor\report-status.ps1`:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude-monitor\report-status.ps1"
```

</details>
```

(保留该段之后的「计数准确性」等章节不动。)

- [ ] **Step 2: README「开发与构建」段补一句自动配置**

找到 `README.md` 第 59-65 行的 `## 开发与构建（Windows）` 代码块。在其后(第 65 行 ``` 之后、`## 测试` 之前)插入:

```markdown

应用首次启动会自动把上报脚本落到 `%USERPROFILE%\.claude-monitor\` 并配置 Windows 侧 Claude Code 钩子(保留你已有的 hooks、自动迁移旧路径),无需手动改路径。
```

- [ ] **Step 3: Commit**

```bash
git add HANDOFF-WINDOWS.md README.md
git commit -m "docs: 钩子改为启动自动配置,更新 HANDOFF/README"
```

---

## Task 8: 验证

**Files:** 无(验证步骤)

- [ ] **Step 1: 全量单测**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: `test result: ok. 5 passed`(merge_hooks 全绿)。

- [ ] **Step 2: dev 手测 —— 落脚本 + 自动配置**

Run:
```bash
npm run tauri dev
```
应用启动后,另开终端检查:
```bash
ls "$USERPROFILE/.claude-monitor/report-status.ps1"
cat "$USERPROFILE/.claude/settings.json"
```
Expected:
- `.claude-monitor/report-status.ps1` 存在,内容与 `hooks/report-status.ps1` 一致。
- `settings.json` 含 6 个事件,command 指向 `.claude-monitor\report-status.ps1`;你原有的其他字段/hooks 完好;存在 `settings.json.monitorbak` 备份。
- 再次 `npm run tauri dev` 启动:settings.json 不产生重复 hook 条目(幂等)。

- [ ] **Step 3: dev 手测 —— 迁移旧路径(若当前 settings.json 已有写死路径)**

若你的 `settings.json` 当前已有 `D:\develop\...\report-status.ps1` 写死路径:启动后它应被迁移为 `.claude-monitor\report-status.ps1`(每个事件仍只 1 条,不重复)。

- [ ] **Step 4: dev 手测 —— 托盘重配 + toast**

应用运行中点托盘「重配 Claude 钩子」,Expected:右下角浮窗显示「✅ Claude 钩子已配置」。

- [ ] **Step 5: 容错手测(可选)**

临时把 `settings.json` 改成非法 JSON(如 `{ broken`),启动应用。Expected:应用正常启动(不 panic),日志有 `ensure_hooks` 相关输出,`.monitorbak` 保留了损坏原文,settings.json 被重建为只含 6 事件的合法结构。测完用 `.monitorbak` 还原你原来的配置。

- [ ] **Step 6: 收尾**

所有验收标准(spec「验收标准」1-6)逐条对照确认后,无需额外 commit(本任务无代码改动)。

---

## Self-Review(计划作者已完成)

- **Spec 覆盖**:ps1 打包(T5)✓ / 落脚本(T2)✓ / 合并 settings.json 纯函数+幂等+迁移+保留+降级(T1 测试)✓ / 启动自动+托盘(T3+T4)✓ / 错误处理不 panic(T2/T3)✓ / dev vs release(T2 回退)✓ / 测试(T1)✓ / 文档(T7)✓ / 验收(T8)✓。
- **占位扫描**:无 TBD/TODO,所有代码块完整。
- **类型一致**:`merge_hooks(existing: Value, ps1_path: &str) -> Value`、`ensure_hooks<M: Manager>(app: &M) -> Result<(), String>`、事件名 `hooks-configured` 在 Rust(T4)与前端(T6)一致;托盘 id `rehook` 在 T4 自洽。
