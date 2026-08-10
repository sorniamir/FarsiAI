use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn verify_workspace_write(_path: String, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}
