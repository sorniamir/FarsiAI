use crate::AppState;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct CommandResult {
    stdout: String,
    stderr: String,
    status: i32,
}

fn canonical_existing(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(PathBuf::from(path)).map_err(|error| error.to_string())
}

fn canonical_for_write(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if candidate.exists() {
        return fs::canonicalize(candidate).map_err(|error| error.to_string());
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| "File path must have a parent directory".to_string())?;
    let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "Invalid file name".to_string())?;
    Ok(parent.join(file_name))
}

fn workspace_root(state: &State<AppState>, target: &Path) -> Result<PathBuf, String> {
    let allowed = state
        .allowed_paths
        .lock()
        .map_err(|_| "Permission state unavailable".to_string())?;

    allowed
        .iter()
        .filter(|base| target.starts_with(base))
        .max_by_key(|base| base.components().count())
        .cloned()
        .ok_or_else(|| "Access denied. Approve the workspace directory first.".to_string())
}

fn ensure_access(state: &State<AppState>, target: &Path) -> Result<(), String> {
    workspace_root(state, target).map(|_| ())
}

fn create_backup(state: &State<AppState>, target: &Path) -> Result<Option<PathBuf>, String> {
    if !target.exists() || !target.is_file() {
        return Ok(None);
    }

    let root = workspace_root(state, target)?;
    let backup_dir = root.join(".farsiai-backups");
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let backup = backup_dir.join(format!("{timestamp}-{file_name}.bak"));
    fs::copy(target, &backup).map_err(|error| error.to_string())?;
    Ok(Some(backup))
}

fn normalize_program(command: &str) -> String {
    let lowered = command.trim().to_lowercase();
    lowered
        .strip_suffix(".exe")
        .or_else(|| lowered.strip_suffix(".cmd"))
        .unwrap_or(&lowered)
        .to_string()
}

fn platform_program(normalized: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if matches!(normalized, "npm" | "npx" | "pnpm" | "yarn") {
            return format!("{normalized}.cmd");
        }
    }
    normalized.to_string()
}

#[tauri::command]
pub fn grant_directory_access(path: String, state: State<AppState>) -> Result<(), String> {
    let canonical = canonical_existing(&path)?;
    if !canonical.is_dir() {
        return Err("The selected path is not a directory.".to_string());
    }
    state
        .allowed_paths
        .lock()
        .map_err(|_| "Permission state unavailable".to_string())?
        .insert(canonical);
    Ok(())
}

#[tauri::command]
pub fn list_directory(path: String, state: State<AppState>) -> Result<Vec<FileEntry>, String> {
    let canonical = canonical_existing(&path)?;
    ensure_access(&state, &canonical)?;
    if !canonical.is_dir() {
        return Err("Path is not a directory.".to_string());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(canonical).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(path: String, state: State<AppState>) -> Result<String, String> {
    let canonical = canonical_existing(&path)?;
    ensure_access(&state, &canonical)?;
    if !canonical.is_file() {
        return Err("Path is not a file.".to_string());
    }
    fs::read_to_string(canonical).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String, state: State<AppState>) -> Result<String, String> {
    if content.len() > 5_000_000 {
        return Err("Refusing to write a text file larger than 5 MB in this version.".to_string());
    }
    let target = canonical_for_write(&path)?;
    ensure_access(&state, &target)?;
    let backup = create_backup(&state, &target)?;
    fs::write(&target, content).map_err(|error| error.to_string())?;
    Ok(backup
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default())
}

#[tauri::command]
pub fn run_command(
    command: String,
    args: Vec<String>,
    cwd: String,
    state: State<AppState>,
) -> Result<CommandResult, String> {
    const ALLOWED_PROGRAMS: &[&str] = &["npm", "node", "git", "python", "python3", "pnpm", "yarn", "npx"];

    if args.len() > 64 {
        return Err("Too many command arguments.".to_string());
    }

    let normalized = normalize_program(&command);
    if !ALLOWED_PROGRAMS.contains(&normalized.as_str()) {
        return Err("Command is not in the desktop safe allowlist.".to_string());
    }

    let working_directory = canonical_existing(&cwd)?;
    ensure_access(&state, &working_directory)?;
    if !working_directory.is_dir() {
        return Err("Working directory is invalid.".to_string());
    }

    let executable = platform_program(&normalized);
    let output = Command::new(executable)
        .args(&args)
        .current_dir(working_directory)
        .output()
        .map_err(|error| error.to_string())?;

    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        status: output.status.code().unwrap_or(-1),
    })
}
