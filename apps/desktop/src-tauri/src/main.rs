#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codex_broker;

use codex_broker::CodexState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CodexState::default())
        .invoke_handler(tauri::generate_handler![
            codex_broker::codex_pick_workspace,
            codex_broker::codex_revoke_workspace,
            codex_broker::codex_list_directory,
            codex_broker::codex_read_file,
            codex_broker::codex_search_workspace,
            codex_broker::codex_write_file,
            codex_broker::codex_create_directory,
            codex_broker::codex_undo_change,
            codex_broker::codex_pick_application,
            codex_broker::codex_launch_application,
            codex_broker::codex_run_command,
            codex_broker::codex_cancel_run,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("FarsiAI Desktop");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running FarsiAI Desktop");
}
