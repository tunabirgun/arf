use serde::Serialize;
use std::path::{Path, PathBuf};

// One .md file found by vault_scan; mtime is ms since the epoch (0 when unavailable).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub rel: String,
    pub mtime: f64,
    pub size: u64,
}

// Mirrors the JS walk in TauriBackend.loadAll (same filtering as tauri-plugin-fs read_dir):
// skip dot names and the root attachments/ dir, recurse only into real directories (a symlinked
// dir is not followed), keep every non-directory entry named *.md, unreadable dirs are skipped.
fn scan_walk(dir: &Path, prefix: &str, out: &mut Vec<ScanEntry>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.filter_map(|e| e.ok()) {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if prefix.is_empty() && is_dir && name == "attachments" {
            continue;
        }
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if is_dir {
            scan_walk(&entry.path(), &rel, out);
        } else if name.ends_with(".md") {
            // metadata follows symlinks; on failure keep the entry so JS tries the read and skips it as before
            let (mtime, size) = std::fs::metadata(entry.path())
                .map(|m| {
                    let ms = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as f64)
                        .unwrap_or(0.0);
                    (ms, m.len())
                })
                .unwrap_or((0.0, 0));
            out.push(ScanEntry { rel, mtime, size });
        }
    }
}

pub fn scan_dir(root: &Path) -> Vec<ScanEntry> {
    let mut out = Vec::new();
    scan_walk(root, "", &mut out);
    out
}

// Whether `root` lies strictly inside one of `bases`: the test the capability's static fs scope applies to
// its `$DIR/**` entries. Both sides are canonicalized (on Windows that adds the \\?\ prefix to both, and
// resolves symlinks and `..`), compared component-wise, and a base that cannot be resolved is skipped.
// `**` does not match the base itself, and on unix plugin-fs requires a literal leading dot by default,
// so a dot-named component below the base is not covered either.
pub fn under_dirs(root: &Path, bases: &[PathBuf]) -> bool {
    let Ok(root) = std::fs::canonicalize(root) else { return false };
    bases.iter().filter_map(|b| std::fs::canonicalize(b).ok()).any(|b| match root.strip_prefix(&b) {
        Ok(rest) => {
            rest.components().next().is_some()
                && !(cfg!(unix) && rest.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')))
        }
        Err(_) => false,
    })
}

// One IPC call for the whole vault listing, for the roots plugin-fs itself would let the JS walk read.
// app.fs_scope() holds only the runtime grants (the folder dialog, replayed by persisted-scope), not the
// static `fs:scope` entries of capabilities/default.json, which plugin-fs checks separately. So a root
// is also accepted when it lies under one of the directories those entries name ($HOME, $DOCUMENT,
// $DESKTOP, $DOWNLOAD, each `/**`): this grants nothing plugin-fs does not already allow.
#[tauri::command]
async fn vault_scan(app: tauri::AppHandle, root: String) -> Result<Vec<ScanEntry>, String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    let allowed = scope.is_allowed(&root) || (!scope.is_forbidden(&root) && {
        let p = app.path();
        let bases: Vec<PathBuf> = [p.home_dir(), p.document_dir(), p.desktop_dir(), p.download_dir()]
            .into_iter()
            .filter_map(|d| d.ok())
            .collect();
        under_dirs(Path::new(&root), &bases)
    });
    if !allowed {
        return Err("vault root is outside the allowed file scope".into());
    }
    tauri::async_runtime::spawn_blocking(move || scan_dir(Path::new(&root)))
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance must be the first plugin registered; a second launch focuses the window
    #[cfg(desktop)]
    {
        use tauri::Manager;
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        // native HTTP (Rust/reqwest) so open-access PDF fetches bypass the webview CORS wall
        .plugin(tauri_plugin_http::init());

    // persisted-scope must come after fs: it replays dialog-granted vault paths across restarts
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_persisted_scope::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![vault_scan])
        .run(tauri::generate_context!())
        .expect("error while running Arf");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // temp vault removed on drop, so a failing assertion still cleans up
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Self {
            let d = std::env::temp_dir().join(format!("arf-scan-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            Tmp(d)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn rels(root: &Path) -> Vec<String> {
        let mut v: Vec<String> = scan_dir(root).into_iter().map(|e| e.rel).collect();
        v.sort();
        v
    }

    #[test]
    fn walks_nested_folders_with_slash_separators() {
        let t = Tmp::new("nested");
        let r = &t.0;
        fs::create_dir_all(r.join("a/b")).unwrap();
        fs::write(r.join("top.md"), "x").unwrap();
        fs::write(r.join("a/mid.md"), "xy").unwrap();
        fs::write(r.join("a/b/deep.md"), "xyz").unwrap();
        fs::write(r.join("a/b/note.txt"), "no").unwrap();
        assert_eq!(rels(r), ["a/b/deep.md", "a/mid.md", "top.md"]);
        let deep = scan_dir(r).into_iter().find(|e| e.rel == "a/b/deep.md").unwrap();
        assert_eq!(deep.size, 3);
        assert!(deep.mtime > 0.0);
    }

    #[test]
    fn skips_dot_entries_and_wrong_case_extension() {
        let t = Tmp::new("dots");
        let r = &t.0;
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::create_dir_all(r.join("f/.hidden")).unwrap();
        fs::write(r.join(".git/x.md"), "x").unwrap();
        fs::write(r.join(".secret.md"), "x").unwrap();
        fs::write(r.join("f/.hidden/y.md"), "x").unwrap();
        fs::write(r.join("f/ok.md"), "x").unwrap();
        fs::write(r.join("upper.MD"), "x").unwrap();
        assert_eq!(rels(r), ["f/ok.md"]);
    }

    #[test]
    fn skips_root_attachments_but_keeps_nested() {
        let t = Tmp::new("attach");
        let r = &t.0;
        fs::create_dir_all(r.join("attachments")).unwrap();
        fs::create_dir_all(r.join("f/attachments")).unwrap();
        fs::write(r.join("attachments/ref.md"), "x").unwrap();
        fs::write(r.join("f/attachments/keep.md"), "x").unwrap();
        assert_eq!(rels(r), ["f/attachments/keep.md"]);
    }

    #[test]
    fn under_dirs_accepts_only_strict_descendants_of_a_base() {
        let t = Tmp::new("under");
        let r = &t.0;
        fs::create_dir_all(r.join("home/vault/sub")).unwrap();
        fs::create_dir_all(r.join("homer/vault")).unwrap();
        fs::create_dir_all(r.join("docs")).unwrap();
        let bases = vec![r.join("home"), r.join("docs"), r.join("does-not-exist")];
        assert!(under_dirs(&r.join("home/vault"), &bases));
        assert!(under_dirs(&r.join("home/vault/sub"), &bases));
        assert!(!under_dirs(&r.join("home"), &bases), "the base itself is not under $DIR/**");
        assert!(!under_dirs(&r.join("homer/vault"), &bases), "a sibling sharing a name prefix");
        assert!(!under_dirs(&r.join("home/missing"), &bases), "a root that does not exist");
        assert!(!under_dirs(&r.join("home/vault/../../homer/vault"), &bases), "a .. escape");
        assert!(!under_dirs(r, &bases));
        assert!(!under_dirs(&r.join("home/vault"), &[]));
    }

    #[cfg(unix)]
    #[test]
    fn under_dirs_skips_dot_components_on_unix() {
        let t = Tmp::new("underdot");
        let r = &t.0;
        fs::create_dir_all(r.join("home/.hidden/vault")).unwrap();
        assert!(!under_dirs(&r.join("home/.hidden/vault"), &[r.join("home")]));
    }

    #[test]
    fn missing_root_yields_empty() {
        assert!(scan_dir(&std::env::temp_dir().join("arf-scan-does-not-exist")).is_empty());
    }
}
