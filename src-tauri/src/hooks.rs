//! Windows 侧 Claude Code 钩子自动配置：落脚本 + 幂等合并 settings.json。
//!
//! 设计原则（与 ensure_server 一致）：任何失败都不阻断应用启动，最坏情况
//! 只是 Windows 侧 claude 不上报，应用本身照常运行。

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{path::BaseDirectory, Manager, Runtime};

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
fn packed_ps1_source<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
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
fn install_ps1<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
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
pub fn ensure_hooks<R: Runtime, M: Manager<R>>(app: &M) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        for ev in HOOK_EVENTS.iter().copied() {
            let arr = hooks.get(ev).unwrap().as_array().unwrap();
            assert_eq!(arr.len(), 1, "{ev} should have exactly one block");
            assert_eq!(arr[0]["hooks"][0]["command"].as_str().unwrap(), cmd(PS1));
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
        for ev in HOOK_EVENTS.iter().copied() {
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
        for ev in HOOK_EVENTS.iter().copied() {
            assert_eq!(out["hooks"][ev].as_array().unwrap().len(), 1);
        }
    }
}
