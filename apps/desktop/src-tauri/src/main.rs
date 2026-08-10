mod tools;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct AppState {
    pub allowed_paths: Mutex<HashSet<PathBuf>>,
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            tools::grant_directory_access,
            tools::list_directory,
            tools::read_text_file,
            tools::write_text_file,
            tools::run_command,
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
