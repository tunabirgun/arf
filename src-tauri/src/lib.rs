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
        .run(tauri::generate_context!())
        .expect("error while running Arf");
}
