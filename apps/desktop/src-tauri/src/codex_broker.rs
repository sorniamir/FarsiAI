//! Native, capability-based broker for the FarsiAI Codex workspace.
//!
//! The webview never supplies an absolute file or executable path.  A workspace or
//! application capability can only be created by a native picker, and every mutating
//! or process-starting operation is protected by a second native confirmation.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind,
};

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 2_000;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCHED_FILES: usize = 20_000;
const MAX_AUDIT_EVENTS: usize = 500;
const MAX_CHANGES: usize = 200;
const MAX_OUTPUT_BYTES: usize = 250_000;
const MAX_COMMAND_ARGS: usize = 64;
const MAX_COMMAND_ARG_BYTES: usize = 32 * 1024;
const MIN_COMMAND_TIMEOUT_MS: u64 = 1_000;
const MAX_COMMAND_TIMEOUT_MS: u64 = 10 * 60 * 1_000;

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct WorkspaceGrant {
    id: String,
    root: PathBuf,
    name: String,
    granted_at_ms: u64,
}

#[derive(Clone)]
struct ApplicationGrant {
    id: String,
    executable: PathBuf,
    name: String,
    granted_at_ms: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChangeKind {
    ReplacedFile,
    CreatedFile,
    CreatedDirectory,
}

#[derive(Clone)]
struct ChangeRecord {
    id: String,
    workspace_id: String,
    relative_path: String,
    kind: ChangeKind,
    backup_path: Option<PathBuf>,
    before_sha256: Option<String>,
    after_sha256: Option<String>,
    undone: bool,
}

struct ActiveRun {
    cancel: Arc<AtomicBool>,
}

/// Session-scoped broker state. Grants are deliberately not persisted.
#[derive(Default)]
pub struct CodexState {
    workspaces: Mutex<HashMap<String, WorkspaceGrant>>,
    applications: Mutex<HashMap<String, ApplicationGrant>>,
    changes: Mutex<VecDeque<ChangeRecord>>,
    runs: Mutex<HashMap<String, ActiveRun>>,
    audit: Mutex<VecDeque<AuditEvent>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGrantInfo {
    id: String,
    name: String,
    display_path: String,
    granted_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationGrantInfo {
    id: String,
    name: String,
    display_path: String,
    granted_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeResult {
    revoked: bool,
    removed_undo_records: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    name: String,
    relative_path: String,
    is_directory: bool,
    is_symlink: bool,
    size: u64,
    modified_at_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileResult {
    relative_path: String,
    content: String,
    sha256: String,
    size: u64,
    modified_at_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    relative_path: String,
    line: usize,
    column: usize,
    excerpt: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    matches: Vec<SearchMatch>,
    files_scanned: usize,
    truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    operation: String,
    change_id: String,
    relative_path: String,
    before_sha256: Option<String>,
    after_sha256: Option<String>,
    bytes_written: u64,
    backup_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    application_id: String,
    name: String,
    process_id: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionResult {
    run_id: String,
    program: String,
    executable_path: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u64,
    timed_out: bool,
    cancelled: bool,
    output_truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResult {
    run_id: String,
    found: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    id: String,
    timestamp_ms: u64,
    action: String,
    outcome: String,
    workspace_id: Option<String>,
    target: Option<String>,
    detail: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn new_id(prefix: &str) -> String {
    // The capability lives only inside this process.  Hashing several process-local
    // values prevents the renderer from guessing a grant created by another view.
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(now_ms().to_le_bytes());
    hasher.update(counter.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(format!("{:?}", thread::current().id()).as_bytes());
    format!("{prefix}_{}", &hex::encode(hasher.finalize())[..32])
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn path_for_display(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path.to_string_lossy().to_string()
}

fn normalize_relative_for_result(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn capped_detail(value: impl Into<String>) -> String {
    let value = value.into().replace(['\r', '\n'], " ");
    value.chars().take(300).collect()
}

fn push_audit(
    state: &CodexState,
    action: &str,
    outcome: &str,
    workspace_id: Option<&str>,
    target: Option<&str>,
    detail: Option<String>,
) {
    let Ok(mut events) = state.audit.lock() else {
        return;
    };
    events.push_back(AuditEvent {
        id: new_id("audit"),
        timestamp_ms: now_ms(),
        action: action.to_string(),
        outcome: outcome.to_string(),
        workspace_id: workspace_id.map(capped_detail),
        target: target.map(capped_detail),
        detail: detail.map(capped_detail),
    });
    while events.len() > MAX_AUDIT_EVENTS {
        events.pop_front();
    }
}

fn lock_error(label: &str) -> String {
    format!("{label} state is unavailable.")
}

fn get_workspace(state: &CodexState, workspace_id: &str) -> Result<WorkspaceGrant, String> {
    if workspace_id.len() < 8 || workspace_id.len() > 80 {
        return Err("Invalid workspace grant ID.".to_string());
    }
    state
        .workspaces
        .lock()
        .map_err(|_| lock_error("Workspace permission"))?
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "Workspace permission is missing or has been revoked.".to_string())
}

fn get_application(state: &CodexState, application_id: &str) -> Result<ApplicationGrant, String> {
    state
        .applications
        .lock()
        .map_err(|_| lock_error("Application permission"))?
        .get(application_id)
        .cloned()
        .ok_or_else(|| "Application permission is missing or expired.".to_string())
}

fn is_windows_device_name(component: &str) -> bool {
    let trimmed = component.trim_end_matches([' ', '.']);
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit()
        && stem.as_bytes()[3] != b'0')
}

fn is_secret_relative(path: &Path) -> bool {
    let parts: Vec<String> = path
        .components()
        .filter_map(|part| match part {
            Component::Normal(value) => Some(
                value
                    .to_string_lossy()
                    .trim_end_matches([' ', '.'])
                    .to_ascii_lowercase(),
            ),
            _ => None,
        })
        .collect();

    for (index, part) in parts.iter().enumerate() {
        if matches!(
            part.as_str(),
            ".ssh" | ".gnupg" | ".aws" | ".azure" | ".kube" | ".docker"
        ) {
            return true;
        }
        if matches!(
            part.as_str(),
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "credentials"
                | "credentials.json"
                | "secrets.json"
                | "service-account.json"
        ) {
            return true;
        }
        if part == ".env" || (part.starts_with(".env.") && !matches!(part.as_str(), ".env.example" | ".env.sample" | ".env.template")) {
            return true;
        }
        if part.ends_with(".pem")
            || part.ends_with(".p12")
            || part.ends_with(".pfx")
            || part.ends_with(".key")
        {
            return true;
        }
        if index > 0 && parts[index - 1] == ".git" && matches!(part.as_str(), "config" | "credentials") {
            return true;
        }
    }
    false
}

fn validate_relative_path(relative: &str, allow_root: bool) -> Result<PathBuf, String> {
    let value = relative.trim();
    if value.len() > 1_024 {
        return Err("Relative path is too long.".to_string());
    }
    if value.contains('\0') || value.chars().any(|character| character.is_control()) {
        return Err("Path contains forbidden control characters.".to_string());
    }
    if value.is_empty() || value == "." {
        return if allow_root {
            Ok(PathBuf::new())
        } else {
            Err("A file or directory name is required.".to_string())
        };
    }
    if value.starts_with(['/', '\\'])
        || value.contains(':')
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err("Only a relative workspace path is allowed; drive paths and ADS are blocked.".to_string());
    }

    // Check both separator styles regardless of the host running the unit tests.
    for component in value.split(['/', '\\']) {
        if component.is_empty() || component == "." || component == ".." {
            return Err("Path traversal and empty path components are blocked.".to_string());
        }
        if component.ends_with([' ', '.']) {
            return Err("Windows-normalized trailing spaces or dots are blocked.".to_string());
        }
        if is_windows_device_name(component) {
            return Err("Windows device names are not valid workspace paths.".to_string());
        }
    }

    let candidate = PathBuf::from(value);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Path traversal outside the workspace is blocked.".to_string());
    }
    if is_secret_relative(&candidate) {
        return Err("Access to credential and secret paths is blocked by policy.".to_string());
    }
    Ok(candidate)
}

fn ensure_contained(root: &Path, candidate: &Path) -> Result<(), String> {
    if candidate == root || candidate.starts_with(root) {
        Ok(())
    } else {
        Err("The resolved path escapes the approved workspace.".to_string())
    }
}

fn resolve_existing(
    grant: &WorkspaceGrant,
    relative: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let relative_path = validate_relative_path(relative, allow_root)?;
    let lexical = grant.root.join(&relative_path);
    let canonical = fs::canonicalize(&lexical)
        .map_err(|error| format!("Cannot resolve workspace path: {error}"))?;
    ensure_contained(&grant.root, &canonical)?;
    Ok((canonical, relative_path))
}

fn resolve_mutation_target(
    grant: &WorkspaceGrant,
    relative: &str,
) -> Result<(PathBuf, PathBuf, bool), String> {
    let relative_path = validate_relative_path(relative, false)?;
    let lexical = grant.root.join(&relative_path);

    if let Ok(link_metadata) = fs::symlink_metadata(&lexical) {
        if link_metadata.file_type().is_symlink() {
            return Err("Writing through symbolic links is blocked.".to_string());
        }
        let canonical = fs::canonicalize(&lexical)
            .map_err(|error| format!("Cannot resolve target: {error}"))?;
        ensure_contained(&grant.root, &canonical)?;
        return Ok((canonical, relative_path, true));
    }

    let parent = lexical
        .parent()
        .ok_or_else(|| "Target must have an existing parent directory.".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| "The parent directory does not exist. Create it explicitly first.".to_string())?;
    ensure_contained(&grant.root, &canonical_parent)?;
    if !canonical_parent.is_dir() {
        return Err("Target parent is not a directory.".to_string());
    }
    let name = lexical
        .file_name()
        .ok_or_else(|| "Target name is invalid.".to_string())?;
    Ok((canonical_parent.join(name), relative_path, false))
}

fn validate_workspace_root(root: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err("The selected workspace is not a directory.".to_string());
    }
    if root.parent().is_none() || root.components().count() < 3 {
        return Err("Selecting an entire drive or filesystem root is not allowed.".to_string());
    }
    if let Some(name) = root.file_name().and_then(|value| value.to_str()) {
        let lowered = name.to_ascii_lowercase();
        if matches!(
            lowered.as_str(),
            "windows" | "program files" | "program files (x86)" | "programdata" | "appdata" | ".ssh" | ".gnupg"
        ) {
            return Err("System and credential directories cannot be used as a Codex workspace.".to_string());
        }
    }

    for variable in ["USERPROFILE", "WINDIR", "PROGRAMFILES", "PROGRAMDATA", "APPDATA", "LOCALAPPDATA"] {
        let Some(value) = env::var_os(variable) else {
            continue;
        };
        let Ok(protected) = fs::canonicalize(value) else {
            continue;
        };
        if root == protected || (matches!(variable, "APPDATA" | "LOCALAPPDATA") && root.starts_with(&protected)) {
            return Err("Select a project folder instead of a protected user or system directory.".to_string());
        }
    }
    Ok(())
}

fn verify_expected_hash(existing: Option<&[u8]>, expected: Option<&str>) -> Result<Option<String>, String> {
    match existing {
        Some(bytes) => {
            let actual = sha256_bytes(bytes);
            let supplied = expected
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "expectedSha256 is required when replacing an existing file.".to_string())?;
            if supplied.len() != 64 || !supplied.bytes().all(|value| value.is_ascii_hexdigit()) {
                return Err("expectedSha256 must be a 64-character SHA-256 value.".to_string());
            }
            if !actual.eq_ignore_ascii_case(supplied) {
                return Err(format!(
                    "File changed since it was read (SHA-256 conflict; current hash is {actual})."
                ));
            }
            Ok(Some(actual))
        }
        None => {
            if expected.is_some_and(|value| !value.trim().is_empty()) {
                return Err("File does not exist, but an existing-file SHA-256 was supplied.".to_string());
            }
            Ok(None)
        }
    }
}

fn native_confirm(app: &AppHandle, title: &str, message: impl Into<String>) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "اجازه می‌دهم".to_string(),
            "لغو".to_string(),
        ))
        .blocking_show()
}

fn backup_root(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Cannot locate protected backup storage: {error}"))?
        .join("codex-backups")
        .join(workspace_id);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Cannot create protected backup storage: {error}"))?;
    Ok(root)
}

fn create_external_backup(
    app: &AppHandle,
    workspace_id: &str,
    change_id: &str,
    source: &Path,
) -> Result<PathBuf, String> {
    let destination = backup_root(app, workspace_id)?.join(format!("{change_id}.bak"));
    fs::copy(source, &destination)
        .map_err(|error| format!("Cannot create undo backup: {error}"))?;
    if let Ok(file) = File::open(&destination) {
        let _ = file.sync_all();
    }
    Ok(destination)
}

fn sibling_temp_path(target: &Path, token: &str, suffix: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Target has no parent directory.".to_string())?;
    Ok(parent.join(format!(".farsiai-codex-{token}.{suffix}")))
}

fn write_atomicish(target: &Path, bytes: &[u8], token: &str) -> Result<(), String> {
    let temporary = sibling_temp_path(target, token, "new")?;
    let displaced = sibling_temp_path(target, token, "old")?;
    let existed = target.exists();

    let result = (|| {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Cannot create atomic temporary file: {error}"))?;
        output
            .write_all(bytes)
            .map_err(|error| format!("Cannot write temporary file: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("Cannot flush temporary file: {error}"))?;

        if existed {
            let permissions = fs::metadata(target)
                .map_err(|error| error.to_string())?
                .permissions();
            fs::set_permissions(&temporary, permissions)
                .map_err(|error| format!("Cannot preserve file permissions: {error}"))?;
            fs::rename(target, &displaced)
                .map_err(|error| format!("Cannot stage the previous file: {error}"))?;
        }

        if let Err(error) = fs::rename(&temporary, target) {
            if existed {
                let _ = fs::rename(&displaced, target);
            }
            return Err(format!("Cannot atomically install the new file: {error}"));
        }
        if existed {
            fs::remove_file(&displaced)
                .map_err(|error| format!("New file was written, but old staging cleanup failed: {error}"))?;
        }
        Ok(())
    })();

    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    if result.is_err() && displaced.exists() && !target.exists() {
        let _ = fs::rename(&displaced, target);
    }
    result
}

fn store_change(state: &CodexState, record: ChangeRecord) -> Result<(), String> {
    let mut changes = state
        .changes
        .lock()
        .map_err(|_| lock_error("Undo"))?;
    changes.push_back(record);
    while changes.len() > MAX_CHANGES {
        if let Some(expired) = changes.pop_front() {
            if let Some(path) = expired.backup_path {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

fn read_bounded_text(path: &Path, maximum: u64) -> Result<(Vec<u8>, fs::Metadata), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("Cannot inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested path is not a regular file.".to_string());
    }
    if metadata.len() > maximum {
        return Err(format!("File is larger than the {maximum}-byte safety limit."));
    }
    let bytes = fs::read(path).map_err(|error| format!("Cannot read file: {error}"))?;
    if bytes.contains(&0) {
        return Err("Binary files are not exposed to the text Codex broker.".to_string());
    }
    Ok((bytes, metadata))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_pick_workspace(
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<Option<WorkspaceGrantInfo>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("انتخاب پوشه پروژه برای Codex")
        .blocking_pick_folder();
    let Some(selected) = selected else {
        push_audit(&state, "workspace.pick", "cancelled", None, None, None);
        return Ok(None);
    };
    let picked = selected
        .into_path()
        .map_err(|error| format!("Selected folder is not a local filesystem path: {error}"))?;
    let canonical = fs::canonicalize(&picked)
        .map_err(|error| format!("Cannot resolve selected workspace: {error}"))?;
    if let Err(error) = validate_workspace_root(&canonical) {
        push_audit(
            &state,
            "workspace.pick",
            "denied",
            None,
            canonical.file_name().and_then(|value| value.to_str()),
            Some(error.clone()),
        );
        return Err(error);
    }

    let id = new_id("ws");
    let name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Workspace".to_string());
    let granted_at_ms = now_ms();
    let grant = WorkspaceGrant {
        id: id.clone(),
        root: canonical.clone(),
        name: name.clone(),
        granted_at_ms,
    };
    state
        .workspaces
        .lock()
        .map_err(|_| lock_error("Workspace permission"))?
        .insert(id.clone(), grant);
    push_audit(
        &state,
        "workspace.pick",
        "granted",
        Some(&id),
        Some(&name),
        None,
    );
    Ok(Some(WorkspaceGrantInfo {
        id,
        name,
        display_path: path_for_display(&canonical),
        granted_at_ms,
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn codex_revoke_workspace(
    workspace_id: String,
    state: State<'_, CodexState>,
) -> Result<RevokeResult, String> {
    let removed = state
        .workspaces
        .lock()
        .map_err(|_| lock_error("Workspace permission"))?
        .remove(&workspace_id)
        .is_some();

    let mut removed_records = 0usize;
    if removed {
        let mut changes = state.changes.lock().map_err(|_| lock_error("Undo"))?;
        changes.retain(|record| {
            if record.workspace_id == workspace_id {
                removed_records += 1;
                if let Some(path) = &record.backup_path {
                    let _ = fs::remove_file(path);
                }
                false
            } else {
                true
            }
        });
    }
    push_audit(
        &state,
        "workspace.revoke",
        if removed { "revoked" } else { "not_found" },
        Some(&workspace_id),
        None,
        None,
    );
    Ok(RevokeResult {
        revoked: removed,
        removed_undo_records: removed_records,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn codex_list_directory(
    workspace_id: String,
    relative_path: String,
    state: State<'_, CodexState>,
) -> Result<Vec<DirectoryEntry>, String> {
    let grant = get_workspace(&state, &workspace_id)?;
    let (directory, normalized_relative) = resolve_existing(&grant, &relative_path, true)?;
    if !directory.is_dir() {
        return Err("The requested path is not a directory.".to_string());
    }

    let mut entries = Vec::new();
    let reader = fs::read_dir(&directory)
        .map_err(|error| format!("Cannot list workspace directory: {error}"))?;
    for item in reader.take(MAX_DIRECTORY_ENTRIES + 1) {
        if entries.len() == MAX_DIRECTORY_ENTRIES {
            return Err(format!(
                "Directory contains more than {MAX_DIRECTORY_ENTRIES} entries; narrow the path."
            ));
        }
        let item = item.map_err(|error| format!("Cannot inspect directory entry: {error}"))?;
        let mut item_relative = normalized_relative.clone();
        item_relative.push(item.file_name());
        if is_secret_relative(&item_relative) {
            continue;
        }
        let link_metadata = fs::symlink_metadata(item.path())
            .map_err(|error| format!("Cannot inspect directory entry: {error}"))?;
        let canonical = match fs::canonicalize(item.path()) {
            Ok(path) if ensure_contained(&grant.root, &path).is_ok() => path,
            _ => continue,
        };
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("Cannot inspect directory entry: {error}"))?;
        entries.push(DirectoryEntry {
            name: item.file_name().to_string_lossy().to_string(),
            relative_path: normalize_relative_for_result(&item_relative),
            is_directory: metadata.is_dir(),
            is_symlink: link_metadata.file_type().is_symlink(),
            size: if metadata.is_file() { metadata.len() } else { 0 },
            modified_at_ms: modified_ms(&metadata),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    push_audit(
        &state,
        "workspace.list",
        "allowed",
        Some(&workspace_id),
        Some(&relative_path),
        Some(format!("{} visible entries", entries.len())),
    );
    Ok(entries)
}

#[tauri::command(rename_all = "camelCase")]
pub fn codex_read_file(
    workspace_id: String,
    relative_path: String,
    state: State<'_, CodexState>,
) -> Result<TextFileResult, String> {
    let grant = get_workspace(&state, &workspace_id)?;
    let (path, normalized_relative) = resolve_existing(&grant, &relative_path, false)?;
    let (bytes, metadata) = read_bounded_text(&path, MAX_READ_BYTES)?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| "File is not valid UTF-8 text.".to_string())?;
    let result = TextFileResult {
        relative_path: normalize_relative_for_result(&normalized_relative),
        content,
        sha256: sha256_bytes(&bytes),
        size: bytes.len() as u64,
        modified_at_ms: modified_ms(&metadata),
    };
    push_audit(
        &state,
        "workspace.read",
        "allowed",
        Some(&workspace_id),
        Some(&relative_path),
        Some(format!("{} bytes", result.size)),
    );
    Ok(result)
}

fn should_skip_search_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".gradle"
            | ".idea"
            | "coverage"
    )
}

fn collect_search_files(
    grant: &WorkspaceGrant,
    directory: &Path,
    relative_directory: &Path,
    depth: usize,
    files: &mut Vec<(PathBuf, PathBuf)>,
    truncated: &mut bool,
) -> Result<(), String> {
    if depth > 32 || files.len() >= MAX_SEARCHED_FILES {
        *truncated = true;
        return Ok(());
    }
    let entries = match fs::read_dir(directory) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        if files.len() >= MAX_SEARCHED_FILES {
            *truncated = true;
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        let mut relative = relative_directory.to_path_buf();
        relative.push(entry.file_name());
        if is_secret_relative(&relative) {
            continue;
        }
        let Ok(link_metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if link_metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(entry.path()) else {
            continue;
        };
        if ensure_contained(&grant.root, &canonical).is_err() {
            continue;
        }
        if canonical.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !should_skip_search_directory(&name) {
                collect_search_files(
                    grant,
                    &canonical,
                    &relative,
                    depth + 1,
                    files,
                    truncated,
                )?;
            }
        } else if canonical.is_file() {
            files.push((canonical, relative));
        }
    }
    Ok(())
}

fn clipped_excerpt(line: &str) -> String {
    const MAX_EXCERPT_CHARS: usize = 360;
    let clean = line.replace(['\r', '\n', '\0'], " ");
    if clean.chars().count() <= MAX_EXCERPT_CHARS {
        clean
    } else {
        format!("{}…", clean.chars().take(MAX_EXCERPT_CHARS).collect::<String>())
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn codex_search_workspace(
    workspace_id: String,
    query: String,
    relative_path: Option<String>,
    max_results: Option<usize>,
    state: State<'_, CodexState>,
) -> Result<SearchResponse, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 256 || query.contains(['\r', '\n', '\0']) {
        return Err("Search query must contain 1 to 256 printable characters.".to_string());
    }
    let result_limit = max_results.unwrap_or(100);
    if result_limit == 0 || result_limit > MAX_SEARCH_RESULTS {
        return Err(format!("maxResults must be between 1 and {MAX_SEARCH_RESULTS}."));
    }
    let grant = get_workspace(&state, &workspace_id)?;
    let requested = relative_path.unwrap_or_default();
    let (start, relative_start) = resolve_existing(&grant, &requested, true)?;
    if !start.is_dir() {
        return Err("Search root must be a directory.".to_string());
    }

    let mut files = Vec::new();
    let mut truncated = false;
    collect_search_files(
        &grant,
        &start,
        &relative_start,
        0,
        &mut files,
        &mut truncated,
    )?;
    let needle = query.to_lowercase();
    let mut matches = Vec::new();
    let mut files_scanned = 0usize;
    'files: for (path, relative) in files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        files_scanned += 1;
        for (line_index, line) in text.lines().enumerate() {
            let lowered = line.to_lowercase();
            let Some(byte_column) = lowered.find(&needle) else {
                continue;
            };
            // Lowercasing can change Unicode byte width.  This is a display hint, not
            // a byte offset used for mutation.
            let column = lowered[..byte_column].chars().count() + 1;
            matches.push(SearchMatch {
                relative_path: normalize_relative_for_result(&relative),
                line: line_index + 1,
                column,
                excerpt: clipped_excerpt(line),
            });
            if matches.len() == result_limit {
                truncated = true;
                break 'files;
            }
        }
    }
    push_audit(
        &state,
        "workspace.search",
        "allowed",
        Some(&workspace_id),
        Some(&requested),
        Some(format!("{files_scanned} files, {} matches", matches.len())),
    );
    Ok(SearchResponse {
        matches,
        files_scanned,
        truncated,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_write_file(
    workspace_id: String,
    relative_path: String,
    content: String,
    expected_sha256: Option<String>,
    reason: Option<String>,
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<MutationResult, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Refusing to write more than {MAX_WRITE_BYTES} UTF-8 bytes in one operation."
        ));
    }
    let grant = get_workspace(&state, &workspace_id)?;
    let (target, normalized_relative, existed) =
        resolve_mutation_target(&grant, &relative_path)?;

    let existing_bytes = if existed {
        if !target.is_file() {
            return Err("The target exists but is not a regular file.".to_string());
        }
        let (bytes, _) = read_bounded_text(&target, MAX_WRITE_BYTES as u64)?;
        String::from_utf8(bytes.clone())
            .map_err(|_| "Existing file is not valid UTF-8 text.".to_string())?;
        Some(bytes)
    } else {
        None
    };
    let before_sha256 = verify_expected_hash(existing_bytes.as_deref(), expected_sha256.as_deref())?;
    let after_sha256 = sha256_bytes(content.as_bytes());
    let relative_display = normalize_relative_for_result(&normalized_relative);
    let reason = reason
        .filter(|value| !value.trim().is_empty())
        .map(capped_detail)
        .unwrap_or_else(|| "درخواست کاربر در Codex".to_string());
    let message = format!(
        "Codex می‌خواهد این فایل را {} کند:\n\n{}\n\nحجم: {} بایت\nدلیل: {}\n\nقبل از ادامه یک نسخهٔ بازگشت امن خارج از پوشه پروژه نگهداری می‌شود.",
        if existed { "جایگزین" } else { "ایجاد" },
        relative_display,
        content.len(),
        reason
    );
    if !native_confirm(&app, "FarsiAI Codex — تأیید نوشتن فایل", message) {
        push_audit(
            &state,
            "workspace.write",
            "cancelled",
            Some(&workspace_id),
            Some(&relative_display),
            None,
        );
        return Err("File write was cancelled by the user in the native dialog.".to_string());
    }

    // Re-resolve and re-check the hash after confirmation to close the most likely
    // time-of-check/time-of-use window while the dialog was open.
    let (confirmed_target, _, confirmed_exists) =
        resolve_mutation_target(&grant, &relative_path)?;
    if confirmed_target != target || confirmed_exists != existed {
        return Err("Target changed while permission was being confirmed; operation aborted.".to_string());
    }
    if existed {
        let current = fs::read(&target)
            .map_err(|error| format!("Cannot re-check target before writing: {error}"))?;
        verify_expected_hash(Some(&current), expected_sha256.as_deref())?;
    }

    let change_id = new_id("change");
    let backup_path = if existed {
        Some(create_external_backup(
            &app,
            &workspace_id,
            &change_id,
            &target,
        )?)
    } else {
        None
    };
    if let Err(error) = write_atomicish(&target, content.as_bytes(), &change_id) {
        if let Some(path) = backup_path {
            let _ = fs::remove_file(path);
        }
        push_audit(
            &state,
            "workspace.write",
            "failed",
            Some(&workspace_id),
            Some(&relative_display),
            Some(error.clone()),
        );
        return Err(error);
    }
    let installed = fs::canonicalize(&target)
        .map_err(|error| format!("Cannot verify written file: {error}"))?;
    ensure_contained(&grant.root, &installed)?;
    let installed_bytes = fs::read(&installed)
        .map_err(|error| format!("Cannot verify written bytes: {error}"))?;
    if sha256_bytes(&installed_bytes) != after_sha256 {
        return Err("Post-write SHA-256 verification failed.".to_string());
    }

    let record = ChangeRecord {
        id: change_id.clone(),
        workspace_id: workspace_id.clone(),
        relative_path: relative_display.clone(),
        kind: if existed {
            ChangeKind::ReplacedFile
        } else {
            ChangeKind::CreatedFile
        },
        backup_path: backup_path.clone(),
        before_sha256: before_sha256.clone(),
        after_sha256: Some(after_sha256.clone()),
        undone: false,
    };
    if let Err(error) = store_change(&state, record) {
        // A mutation without an undo record is not acceptable. Roll back immediately.
        if let Some(backup) = &backup_path {
            let _ = write_atomicish(&target, &fs::read(backup).unwrap_or_default(), "rollback");
        } else {
            let _ = fs::remove_file(&target);
        }
        return Err(error);
    }
    push_audit(
        &state,
        "workspace.write",
        "completed",
        Some(&workspace_id),
        Some(&relative_display),
        Some(format!("change {change_id}")),
    );
    Ok(MutationResult {
        operation: if existed { "replace_file" } else { "create_file" }.to_string(),
        change_id,
        relative_path: relative_display,
        before_sha256,
        after_sha256: Some(after_sha256),
        bytes_written: content.len() as u64,
        backup_available: backup_path.is_some(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_create_directory(
    workspace_id: String,
    relative_path: String,
    reason: Option<String>,
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<MutationResult, String> {
    let grant = get_workspace(&state, &workspace_id)?;
    let (target, normalized_relative, exists) =
        resolve_mutation_target(&grant, &relative_path)?;
    if exists {
        return Err("The requested directory already exists.".to_string());
    }
    let relative_display = normalize_relative_for_result(&normalized_relative);
    let reason = reason
        .filter(|value| !value.trim().is_empty())
        .map(capped_detail)
        .unwrap_or_else(|| "درخواست کاربر در Codex".to_string());
    if !native_confirm(
        &app,
        "FarsiAI Codex — تأیید ایجاد پوشه",
        format!(
            "Codex می‌خواهد این پوشه را ایجاد کند:\n\n{}\n\nدلیل: {}",
            relative_display, reason
        ),
    ) {
        push_audit(
            &state,
            "workspace.mkdir",
            "cancelled",
            Some(&workspace_id),
            Some(&relative_display),
            None,
        );
        return Err("Directory creation was cancelled by the user.".to_string());
    }
    let (confirmed, _, confirmed_exists) = resolve_mutation_target(&grant, &relative_path)?;
    if confirmed != target || confirmed_exists {
        return Err("Directory target changed while permission was being confirmed.".to_string());
    }

    fs::create_dir(&target).map_err(|error| format!("Cannot create directory: {error}"))?;
    let canonical = fs::canonicalize(&target)
        .map_err(|error| format!("Cannot verify new directory: {error}"))?;
    ensure_contained(&grant.root, &canonical)?;
    let change_id = new_id("change");
    let record = ChangeRecord {
        id: change_id.clone(),
        workspace_id: workspace_id.clone(),
        relative_path: relative_display.clone(),
        kind: ChangeKind::CreatedDirectory,
        backup_path: None,
        before_sha256: None,
        after_sha256: None,
        undone: false,
    };
    if let Err(error) = store_change(&state, record) {
        let _ = fs::remove_dir(&target);
        return Err(error);
    }
    push_audit(
        &state,
        "workspace.mkdir",
        "completed",
        Some(&workspace_id),
        Some(&relative_display),
        Some(format!("change {change_id}")),
    );
    Ok(MutationResult {
        operation: "create_directory".to_string(),
        change_id,
        relative_path: relative_display,
        before_sha256: None,
        after_sha256: None,
        bytes_written: 0,
        backup_available: false,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_undo_change(
    workspace_id: String,
    change_id: String,
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<MutationResult, String> {
    let grant = get_workspace(&state, &workspace_id)?;
    let record = state
        .changes
        .lock()
        .map_err(|_| lock_error("Undo"))?
        .iter()
        .find(|record| record.id == change_id && record.workspace_id == workspace_id)
        .cloned()
        .ok_or_else(|| "Undo record was not found for this workspace.".to_string())?;
    if record.undone {
        return Err("This change has already been undone.".to_string());
    }

    let (target, _, exists) = resolve_mutation_target(&grant, &record.relative_path)?;
    match record.kind {
        ChangeKind::ReplacedFile | ChangeKind::CreatedFile => {
            if !exists || !target.is_file() {
                return Err("Current file no longer exists; undo stopped to protect newer work.".to_string());
            }
            let current = fs::read(&target)
                .map_err(|error| format!("Cannot verify current file before undo: {error}"))?;
            if record.after_sha256.as_deref() != Some(sha256_bytes(&current).as_str()) {
                return Err("Current file changed after the Codex edit; undo conflict detected.".to_string());
            }
        }
        ChangeKind::CreatedDirectory => {
            if !exists || !target.is_dir() {
                return Err("Created directory no longer exists.".to_string());
            }
            if fs::read_dir(&target)
                .map_err(|error| format!("Cannot inspect directory for undo: {error}"))?
                .next()
                .is_some()
            {
                return Err("Directory is no longer empty, so automatic undo is blocked.".to_string());
            }
        }
    }
    if !native_confirm(
        &app,
        "FarsiAI Codex — تأیید بازگردانی",
        format!(
            "این تغییر Codex بازگردانده شود؟\n\n{}\n\nشناسه تغییر: {}",
            record.relative_path, record.id
        ),
    ) {
        push_audit(
            &state,
            "workspace.undo",
            "cancelled",
            Some(&workspace_id),
            Some(&record.relative_path),
            None,
        );
        return Err("Undo was cancelled by the user.".to_string());
    }

    match record.kind {
        ChangeKind::ReplacedFile => {
            let backup = record
                .backup_path
                .as_ref()
                .ok_or_else(|| "Protected undo backup is missing.".to_string())?;
            let backup_bytes = fs::read(backup)
                .map_err(|error| format!("Cannot read protected undo backup: {error}"))?;
            if record.before_sha256.as_deref() != Some(sha256_bytes(&backup_bytes).as_str()) {
                return Err("Undo backup SHA-256 verification failed.".to_string());
            }
            write_atomicish(&target, &backup_bytes, &format!("undo-{change_id}"))?;
        }
        ChangeKind::CreatedFile => {
            fs::remove_file(&target)
                .map_err(|error| format!("Cannot remove Codex-created file: {error}"))?;
        }
        ChangeKind::CreatedDirectory => {
            fs::remove_dir(&target)
                .map_err(|error| format!("Cannot remove Codex-created directory: {error}"))?;
        }
    }

    {
        let mut changes = state.changes.lock().map_err(|_| lock_error("Undo"))?;
        let stored = changes
            .iter_mut()
            .find(|stored| stored.id == change_id && stored.workspace_id == workspace_id)
            .ok_or_else(|| "Undo record disappeared before completion.".to_string())?;
        stored.undone = true;
    }
    if let Some(path) = &record.backup_path {
        let _ = fs::remove_file(path);
    }
    push_audit(
        &state,
        "workspace.undo",
        "completed",
        Some(&workspace_id),
        Some(&record.relative_path),
        Some(format!("change {change_id}")),
    );
    Ok(MutationResult {
        operation: "undo".to_string(),
        change_id,
        relative_path: record.relative_path,
        before_sha256: record.after_sha256,
        after_sha256: record.before_sha256,
        bytes_written: 0,
        backup_available: false,
    })
}

fn blocked_application_name(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "cmd.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "wscript.exe"
            | "cscript.exe"
            | "mshta.exe"
            | "rundll32.exe"
            | "regsvr32.exe"
            | "reg.exe"
            | "sc.exe"
            | "schtasks.exe"
            | "certutil.exe"
            | "bitsadmin.exe"
            | "wmic.exe"
            | "msiexec.exe"
            | "taskkill.exe"
    )
}

fn validate_process_args(args: &[String], for_script_wrapper: bool) -> Result<(), String> {
    if args.len() > MAX_COMMAND_ARGS {
        return Err(format!("No more than {MAX_COMMAND_ARGS} arguments are allowed."));
    }
    let total: usize = args.iter().map(String::len).sum();
    if total > MAX_COMMAND_ARG_BYTES {
        return Err("Combined process arguments are too large.".to_string());
    }
    for argument in args {
        if argument.contains('\0')
            || argument.contains(['\r', '\n'])
            || argument.chars().any(|character| character.is_control())
        {
            return Err("Process argument contains forbidden control characters.".to_string());
        }
        if for_script_wrapper && argument.contains(['&', '|', '<', '>', '^', '%', '!']) {
            return Err("Shell metacharacters are blocked for command-wrapper executables.".to_string());
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_pick_application(
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<Option<ApplicationGrantInfo>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("انتخاب برنامه برای Codex")
        .add_filter("Windows applications", &["exe"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        push_audit(&state, "application.pick", "cancelled", None, None, None);
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Selected application is not a local file: {error}"))?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Cannot resolve selected application: {error}"))?;
    if !canonical.is_file()
        || !canonical
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err("Only an existing Windows .exe application can be approved.".to_string());
    }
    if blocked_application_name(&canonical) {
        push_audit(
            &state,
            "application.pick",
            "denied",
            None,
            canonical.file_name().and_then(|value| value.to_str()),
            Some("High-risk system utility".to_string()),
        );
        return Err("Command shells, script hosts, installers, and high-risk system utilities cannot be granted as applications.".to_string());
    }

    let id = new_id("app");
    let name = canonical
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Application".to_string());
    let granted_at_ms = now_ms();
    state
        .applications
        .lock()
        .map_err(|_| lock_error("Application permission"))?
        .insert(
            id.clone(),
            ApplicationGrant {
                id: id.clone(),
                executable: canonical.clone(),
                name: name.clone(),
                granted_at_ms,
            },
        );
    push_audit(
        &state,
        "application.pick",
        "granted",
        None,
        Some(&name),
        None,
    );
    Ok(Some(ApplicationGrantInfo {
        id,
        name,
        display_path: path_for_display(&canonical),
        granted_at_ms,
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_launch_application(
    application_id: String,
    args: Vec<String>,
    reason: Option<String>,
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<LaunchResult, String> {
    let grant = get_application(&state, &application_id)?;
    validate_process_args(&args, false)?;
    let canonical = fs::canonicalize(&grant.executable)
        .map_err(|_| "Approved application no longer exists.".to_string())?;
    if canonical != grant.executable || blocked_application_name(&canonical) {
        return Err("Approved application changed on disk; choose it again.".to_string());
    }
    let argument_preview = if args.is_empty() {
        "(بدون آرگومان)".to_string()
    } else {
        args.iter()
            .map(|value| capped_detail(value))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let reason = reason
        .filter(|value| !value.trim().is_empty())
        .map(capped_detail)
        .unwrap_or_else(|| "درخواست کاربر در Codex".to_string());
    if !native_confirm(
        &app,
        "FarsiAI Codex — تأیید اجرای برنامه",
        format!(
            "Codex می‌خواهد برنامه زیر را اجرا کند:\n\n{}\n{}\n\nآرگومان‌ها: {}\nدلیل: {}",
            grant.name,
            path_for_display(&canonical),
            argument_preview,
            reason
        ),
    ) {
        push_audit(
            &state,
            "application.launch",
            "cancelled",
            None,
            Some(&grant.name),
            None,
        );
        return Err("Application launch was cancelled by the user.".to_string());
    }

    let child = Command::new(&canonical)
        .args(&args)
        .spawn()
        .map_err(|error| format!("Cannot launch approved application: {error}"))?;
    let process_id = child.id();
    push_audit(
        &state,
        "application.launch",
        "started",
        None,
        Some(&grant.name),
        Some(format!("pid {process_id}")),
    );
    Ok(LaunchResult {
        application_id,
        name: grant.name,
        process_id,
    })
}

struct ProgramProfile {
    name: &'static str,
    windows_files: &'static [&'static str],
    label: &'static str,
}

fn program_profile(program: &str) -> Option<ProgramProfile> {
    let profile = match program {
        "git" => ProgramProfile { name: "git", windows_files: &["git.exe"], label: "Git (read-only profile)" },
        "node" => ProgramProfile { name: "node", windows_files: &["node.exe"], label: "Node.js project script" },
        "python" => ProgramProfile { name: "python", windows_files: &["python.exe", "python3.exe"], label: "Python project script/test" },
        "python3" => ProgramProfile { name: "python3", windows_files: &["python3.exe", "python.exe"], label: "Python project script/test" },
        "pytest" => ProgramProfile { name: "pytest", windows_files: &["pytest.exe"], label: "Python tests" },
        "npm" => ProgramProfile { name: "npm", windows_files: &["npm.cmd"], label: "npm project task" },
        "npx" => ProgramProfile { name: "npx", windows_files: &["npx.cmd"], label: "Approved Node.js project tool" },
        "pnpm" => ProgramProfile { name: "pnpm", windows_files: &["pnpm.cmd", "pnpm.exe"], label: "pnpm project task" },
        "yarn" => ProgramProfile { name: "yarn", windows_files: &["yarn.cmd"], label: "Yarn project task" },
        "bun" => ProgramProfile { name: "bun", windows_files: &["bun.exe"], label: "Bun project task" },
        "deno" => ProgramProfile { name: "deno", windows_files: &["deno.exe"], label: "Deno check/test task" },
        "cargo" => ProgramProfile { name: "cargo", windows_files: &["cargo.exe"], label: "Rust build/test task" },
        "rustc" => ProgramProfile { name: "rustc", windows_files: &["rustc.exe"], label: "Rust compiler" },
        "go" => ProgramProfile { name: "go", windows_files: &["go.exe"], label: "Go build/test task" },
        "dotnet" => ProgramProfile { name: "dotnet", windows_files: &["dotnet.exe"], label: ".NET build/test task" },
        "java" => ProgramProfile { name: "java", windows_files: &["java.exe"], label: "Java project task" },
        "javac" => ProgramProfile { name: "javac", windows_files: &["javac.exe"], label: "Java compiler" },
        "mvn" => ProgramProfile { name: "mvn", windows_files: &["mvn.cmd", "mvn.exe"], label: "Maven build/test task" },
        "gradle" => ProgramProfile { name: "gradle", windows_files: &["gradle.bat", "gradle.exe"], label: "Gradle build/test task" },
        "ruff" => ProgramProfile { name: "ruff", windows_files: &["ruff.exe"], label: "Python linter/formatter" },
        "tsc" => ProgramProfile { name: "tsc", windows_files: &["tsc.cmd"], label: "TypeScript compiler" },
        "eslint" => ProgramProfile { name: "eslint", windows_files: &["eslint.cmd"], label: "JavaScript linter" },
        "prettier" => ProgramProfile { name: "prettier", windows_files: &["prettier.cmd"], label: "Code formatter" },
        "vitest" => ProgramProfile { name: "vitest", windows_files: &["vitest.cmd"], label: "JavaScript tests" },
        _ => return None,
    };
    Some(profile)
}

fn argument_has_external_path(argument: &str) -> bool {
    if argument.starts_with(['/', '\\'])
        || argument.as_bytes().get(1) == Some(&b':')
        || Path::new(argument).is_absolute()
    {
        return true;
    }
    argument
        .split(['/', '\\'])
        .any(|component| component == "..")
}

fn validate_project_script(
    grant: &WorkspaceGrant,
    argument: &str,
    extensions: &[&str],
) -> Result<(), String> {
    let (path, _) = resolve_existing(grant, argument, false)?;
    if !path.is_file() {
        return Err("Project script argument is not a regular file.".to_string());
    }
    if !extensions.is_empty()
        && !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                extensions
                    .iter()
                    .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            })
    {
        return Err("Project script has an extension outside this command profile.".to_string());
    }
    Ok(())
}

fn first_command_word(args: &[String]) -> Option<&str> {
    args.iter()
        .find(|argument| !argument.starts_with('-'))
        .map(String::as_str)
}

fn validate_command_profile(
    profile: &ProgramProfile,
    args: &[String],
    grant: &WorkspaceGrant,
) -> Result<(), String> {
    validate_process_args(args, false)?;
    const EXTERNAL_PATH_FLAGS: &[&str] = &[
        "--cwd",
        "--chdir",
        "--prefix",
        "--global",
        "--git-dir",
        "--work-tree",
        "--exec-path",
        "--upload-pack",
        "--config-env",
    ];
    for argument in args {
        let lowered = argument.to_ascii_lowercase();
        if EXTERNAL_PATH_FLAGS
            .iter()
            .any(|flag| lowered == *flag || lowered.starts_with(&format!("{flag}=")))
            || lowered == "-g"
            || lowered == "-c"
        {
            return Err("Command argument can redirect execution outside the approved project.".to_string());
        }
        if !argument.starts_with('-') && argument_has_external_path(argument) {
            return Err("Absolute paths and parent traversal are blocked in command arguments.".to_string());
        }
    }

    let first = first_command_word(args).unwrap_or("").to_ascii_lowercase();
    match profile.name {
        "git" => {
            if args.iter().any(|argument| {
                let value = argument.to_ascii_lowercase();
                value.starts_with("-c")
                    || value.starts_with("--config")
                    || value.starts_with("--namespace")
            }) {
                return Err("Git configuration injection is blocked.".to_string());
            }
            const ALLOWED: &[&str] = &[
                "", "status", "diff", "log", "show", "branch", "rev-parse", "ls-files",
                "grep", "describe", "check-ignore", "blame", "shortlog", "tag",
            ];
            if !ALLOWED.contains(&first.as_str()) && !args.iter().any(|value| value == "--version") {
                return Err("Git is restricted to read-only inspection commands.".to_string());
            }
        }
        "node" => {
            const BLOCKED: &[&str] = &[
                "-e", "--eval", "-p", "--print", "-r", "--require", "--import",
                "--loader", "--experimental-loader", "--inspect", "--inspect-brk",
            ];
            if args.iter().any(|value| {
                let lowered = value.to_ascii_lowercase();
                BLOCKED
                    .iter()
                    .any(|blocked| lowered == *blocked || lowered.starts_with(&format!("{blocked}=")))
            }) {
                return Err("Inline code, loaders, and debugger injection are blocked for Node.js.".to_string());
            }
            if !first.is_empty()
                && !first.starts_with("--")
                && !matches!(first.as_str(), "test" | "check")
            {
                validate_project_script(grant, &first, &["js", "mjs", "cjs"])?;
            }
        }
        "python" | "python3" => {
            if args.iter().any(|value| value == "-c") {
                return Err("Inline Python code is blocked.".to_string());
            }
            if let Some(index) = args.iter().position(|value| value == "-m") {
                let module = args.get(index + 1).map(String::as_str).unwrap_or("");
                if !matches!(module, "pytest" | "unittest" | "compileall") {
                    return Err("Python -m is limited to pytest, unittest, and compileall.".to_string());
                }
            } else if !first.is_empty() && !first.starts_with('-') {
                validate_project_script(grant, &first, &["py"])?;
            }
        }
        "npm" | "pnpm" | "yarn" => {
            const ALLOWED: &[&str] = &["", "test", "run", "exec", "version", "list", "why"];
            if !ALLOWED.contains(&first.as_str()) {
                return Err("Package manager is limited to project scripts, tests, and inspection.".to_string());
            }
        }
        "npx" => {
            const ALLOWED: &[&str] = &[
                "tsc", "eslint", "prettier", "vite", "vitest", "jest", "playwright",
                "tailwindcss",
            ];
            if !ALLOWED.contains(&first.as_str()) {
                return Err("npx may run only an approved development tool.".to_string());
            }
        }
        "bun" => {
            if !["", "test", "run", "build", "x"].contains(&first.as_str()) {
                return Err("Bun is limited to build, test, run, and approved tool tasks.".to_string());
            }
        }
        "deno" => {
            if !["", "check", "test", "fmt", "lint", "task"].contains(&first.as_str()) {
                return Err("Deno is limited to check, test, format, lint, and project tasks.".to_string());
            }
            if args.iter().any(|value| value.starts_with("--allow-") || value == "-A") {
                return Err("Deno elevated permission flags are blocked.".to_string());
            }
        }
        "cargo" => {
            if !["", "check", "test", "build", "fmt", "clippy", "metadata", "run"]
                .contains(&first.as_str())
            {
                return Err("Cargo command is outside the build/test profile.".to_string());
            }
        }
        "go" => {
            if !["", "test", "build", "fmt", "vet", "list"].contains(&first.as_str()) {
                return Err("Go command is outside the build/test profile.".to_string());
            }
        }
        "dotnet" => {
            if !["", "build", "test", "format", "restore", "run"].contains(&first.as_str()) {
                return Err("dotnet command is outside the build/test profile.".to_string());
            }
        }
        "mvn" | "gradle" => {
            let lowered = args.join(" ").to_ascii_lowercase();
            if ["publish", "deploy", "upload", "release"]
                .iter()
                .any(|blocked| lowered.split_whitespace().any(|word| word == *blocked))
            {
                return Err("Publishing and deployment tasks are blocked.".to_string());
            }
        }
        "ruff" => {
            if !["", "check", "format", "version"].contains(&first.as_str()) {
                return Err("Ruff is limited to checking and formatting.".to_string());
            }
        }
        "rustc" => {
            if let Some(source) = args.iter().find(|value| value.to_ascii_lowercase().ends_with(".rs")) {
                validate_project_script(grant, source, &["rs"])?;
            } else if !args.iter().any(|value| value == "--version") {
                return Err("rustc requires a relative .rs source file.".to_string());
            }
        }
        // These tools operate directly without a shell; general path containment and
        // the native confirmation remain in force.
        "pytest" | "java" | "javac" | "tsc" | "eslint" | "prettier" | "vitest" => {}
        _ => return Err("Command profile is not implemented.".to_string()),
    }
    Ok(())
}

fn resolve_executable(
    profile: &ProgramProfile,
    workspace_root: &Path,
) -> Result<PathBuf, String> {
    let path_value = env::var_os("PATH").ok_or_else(|| "System PATH is unavailable.".to_string())?;
    let mut seen = HashSet::new();
    for directory in env::split_paths(&path_value) {
        if !directory.is_absolute() {
            continue;
        }
        #[cfg(target_os = "windows")]
        let names: Vec<&str> = profile.windows_files.to_vec();
        #[cfg(not(target_os = "windows"))]
        let names: Vec<&str> = vec![profile.name];
        for name in names {
            let candidate = directory.join(name);
            if !candidate.is_file() {
                continue;
            }
            let Ok(canonical) = fs::canonicalize(candidate) else {
                continue;
            };
            if !seen.insert(canonical.clone()) || canonical.starts_with(workspace_root) {
                continue;
            }
            return Ok(canonical);
        }
    }
    Err(format!(
        "Approved executable '{}' was not found on PATH outside the workspace.",
        profile.name
    ))
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.len() < 8
        || run_id.len() > 96
        || !run_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err("runId must be 8-96 ASCII letters, digits, '-' or '_'.".to_string());
    }
    Ok(())
}

fn drain_bounded<R: Read>(mut reader: R) -> (Vec<u8>, bool) {
    let mut captured = Vec::new();
    let mut buffer = [0u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(captured.len());
        let retained = count.min(remaining);
        captured.extend_from_slice(&buffer[..retained]);
        if retained < count {
            truncated = true;
        }
    }
    (captured, truncated)
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if let Some(system_root) = env::var_os("SystemRoot") {
        let taskkill = PathBuf::from(system_root).join("System32").join("taskkill.exe");
        if taskkill.is_file() {
            let _ = Command::new(taskkill)
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    let _ = child.kill();
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
}

fn remove_injection_environment(command: &mut Command) {
    for key in [
        "NODE_OPTIONS",
        "PYTHONPATH",
        "PYTHONHOME",
        "RUSTC_WRAPPER",
        "RUSTDOC",
        "GIT_SSH_COMMAND",
        "GIT_EXTERNAL_DIFF",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "BASH_ENV",
        "ENV",
        "PROMPT_COMMAND",
    ] {
        command.env_remove(key);
    }
    command.env("GIT_TERMINAL_PROMPT", "0");
}

fn execute_command_process(
    run_id: String,
    program: String,
    executable: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    timeout_ms: u64,
    cancel: Arc<AtomicBool>,
) -> Result<CommandExecutionResult, String> {
    let started = Instant::now();
    let mut command = Command::new(&executable);
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    remove_injection_environment(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start approved command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cannot capture command stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Cannot capture command stderr.".to_string())?;
    let stdout_reader = thread::spawn(move || drain_bounded(stdout));
    let stderr_reader = thread::spawn(move || drain_bounded(stderr));

    let mut timed_out = false;
    let mut cancelled = false;
    let exit_status = loop {
        if cancel.load(Ordering::Acquire) {
            cancelled = true;
            terminate_process_tree(&mut child);
            break child.wait().ok();
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            timed_out = true;
            terminate_process_tree(&mut child);
            break child.wait().ok();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                terminate_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("Cannot monitor approved command: {error}"));
            }
        }
    };

    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| "stdout capture worker failed.".to_string())?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| "stderr capture worker failed.".to_string())?;
    let mut stdout = String::from_utf8_lossy(&stdout).to_string();
    let mut stderr = String::from_utf8_lossy(&stderr).to_string();
    if stdout_truncated {
        stdout.push_str("\n...[stdout truncated by FarsiAI Codex]");
    }
    if stderr_truncated {
        stderr.push_str("\n...[stderr truncated by FarsiAI Codex]");
    }
    Ok(CommandExecutionResult {
        run_id,
        program,
        executable_path: path_for_display(&executable),
        stdout,
        stderr,
        exit_code: exit_status.and_then(|status| status.code()),
        duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        timed_out,
        cancelled,
        output_truncated: stdout_truncated || stderr_truncated,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn codex_run_command(
    workspace_id: String,
    run_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    reason: Option<String>,
    app: AppHandle,
    state: State<'_, CodexState>,
) -> Result<CommandExecutionResult, String> {
    validate_run_id(&run_id)?;
    let normalized_program = program.trim().to_ascii_lowercase();
    if normalized_program != program.trim()
        || normalized_program.is_empty()
        || !normalized_program
            .bytes()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
    {
        return Err("Program must be an exact lowercase executable profile name.".to_string());
    }
    let profile = program_profile(&normalized_program)
        .ok_or_else(|| "Program is not in the Codex command profile allowlist.".to_string())?;
    let grant = get_workspace(&state, &workspace_id)?;
    validate_command_profile(&profile, &args, &grant)?;
    let requested_cwd = cwd.unwrap_or_default();
    let (working_directory, normalized_cwd) =
        resolve_existing(&grant, &requested_cwd, true)?;
    if !working_directory.is_dir() {
        return Err("Command working directory is not a directory.".to_string());
    }
    let timeout_ms = timeout_ms.unwrap_or(120_000);
    if !(MIN_COMMAND_TIMEOUT_MS..=MAX_COMMAND_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!(
            "timeoutMs must be between {MIN_COMMAND_TIMEOUT_MS} and {MAX_COMMAND_TIMEOUT_MS}."
        ));
    }
    let executable = resolve_executable(&profile, &grant.root)?;
    let wrapper = executable
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    validate_process_args(&args, wrapper)?;
    let executable_metadata = fs::metadata(&executable)
        .map_err(|error| format!("Cannot inspect approved executable: {error}"))?;
    let executable_identity = (executable_metadata.len(), modified_ms(&executable_metadata));
    let args_preview = if args.is_empty() {
        "(بدون آرگومان)".to_string()
    } else {
        args.iter()
            .map(|value| capped_detail(value))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let reason = reason
        .filter(|value| !value.trim().is_empty())
        .map(capped_detail)
        .unwrap_or_else(|| "بررسی یا تست پروژه توسط Codex".to_string());
    if !native_confirm(
        &app,
        "FarsiAI Codex — تأیید اجرای دستور",
        format!(
            "Codex می‌خواهد یک دستور کنترل‌شده اجرا کند:\n\nپروفایل: {}\nفایل اجرایی: {}\nپوشه: {}\nآرگومان‌ها: {}\nمهلت: {} ثانیه\nدلیل: {}\n\nپوستهٔ آزاد و ورودی تعاملی غیرفعال است.",
            profile.label,
            path_for_display(&executable),
            normalize_relative_for_result(&normalized_cwd),
            args_preview,
            timeout_ms / 1_000,
            reason
        ),
    ) {
        push_audit(
            &state,
            "command.run",
            "cancelled",
            Some(&workspace_id),
            Some(&normalized_program),
            Some(format!("run {run_id}")),
        );
        return Err("Command execution was cancelled by the user.".to_string());
    }

    let canonical_executable = fs::canonicalize(&executable)
        .map_err(|_| "Executable disappeared while permission was being confirmed.".to_string())?;
    let refreshed_metadata = fs::metadata(&canonical_executable)
        .map_err(|error| format!("Cannot re-check approved executable: {error}"))?;
    if canonical_executable != executable
        || (refreshed_metadata.len(), modified_ms(&refreshed_metadata)) != executable_identity
    {
        return Err("Executable changed while permission was being confirmed; run aborted.".to_string());
    }
    let refreshed_cwd = fs::canonicalize(&working_directory)
        .map_err(|_| "Working directory disappeared before command execution.".to_string())?;
    ensure_contained(&grant.root, &refreshed_cwd)?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut runs = state.runs.lock().map_err(|_| lock_error("Command run"))?;
        if runs.contains_key(&run_id) {
            return Err("runId is already active.".to_string());
        }
        runs.insert(
            run_id.clone(),
            ActiveRun {
                cancel: cancel.clone(),
            },
        );
    }
    push_audit(
        &state,
        "command.run",
        "started",
        Some(&workspace_id),
        Some(&normalized_program),
        Some(format!("run {run_id}")),
    );

    let worker_run_id = run_id.clone();
    let worker_program = normalized_program.clone();
    let worker_executable = executable.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        execute_command_process(
            worker_run_id,
            worker_program,
            worker_executable,
            args,
            refreshed_cwd,
            timeout_ms,
            cancel,
        )
    })
    .await
    .map_err(|error| format!("Command worker failed: {error}"));
    if let Ok(mut runs) = state.runs.lock() {
        runs.remove(&run_id);
    }
    let result = result??;
    let outcome = if result.cancelled {
        "cancelled"
    } else if result.timed_out {
        "timed_out"
    } else if result.exit_code == Some(0) {
        "completed"
    } else {
        "failed"
    };
    push_audit(
        &state,
        "command.run",
        outcome,
        Some(&workspace_id),
        Some(&normalized_program),
        Some(format!(
            "run {run_id}, exit {:?}, {} ms",
            result.exit_code, result.duration_ms
        )),
    );
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn codex_cancel_run(
    run_id: String,
    state: State<'_, CodexState>,
) -> Result<CancelRunResult, String> {
    validate_run_id(&run_id)?;
    let found = {
        let runs = state.runs.lock().map_err(|_| lock_error("Command run"))?;
        if let Some(active) = runs.get(&run_id) {
            active.cancel.store(true, Ordering::Release);
            true
        } else {
            false
        }
    };
    push_audit(
        &state,
        "command.cancel",
        if found { "requested" } else { "not_found" },
        None,
        Some(&run_id),
        None,
    );
    Ok(CancelRunResult { run_id, found })
}

#[tauri::command(rename_all = "camelCase")]
pub fn codex_list_audit(
    limit: Option<usize>,
    state: State<'_, CodexState>,
) -> Result<Vec<AuditEvent>, String> {
    let limit = limit.unwrap_or(100);
    if limit == 0 || limit > MAX_AUDIT_EVENTS {
        return Err(format!("limit must be between 1 and {MAX_AUDIT_EVENTS}."));
    }
    let events = state.audit.lock().map_err(|_| lock_error("Audit"))?;
    Ok(events.iter().rev().take(limit).cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_workspace(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("farsiai-codex-broker-{label}-{}", new_id("test")));
        fs::create_dir_all(&path).expect("create temporary workspace");
        fs::canonicalize(path).expect("canonical temporary workspace")
    }

    #[test]
    fn relative_path_rejects_all_traversal_and_absolute_forms() {
        for blocked in [
            "../outside.txt",
            "safe/../../outside.txt",
            r"safe\..\outside.txt",
            r"C:\outside.txt",
            r"\\server\share\file.txt",
            "/etc/passwd",
            "safe//file.txt",
            r"safe\\file.txt",
        ] {
            assert!(
                validate_relative_path(blocked, false).is_err(),
                "must reject {blocked:?}"
            );
        }
        assert!(validate_relative_path("src/components/App.tsx", false).is_ok());
    }

    #[test]
    fn relative_path_rejects_ntfs_alternate_data_streams() {
        for blocked in ["notes.txt:payload", "folder/file.js:$DATA", "a:b:c"] {
            let error = validate_relative_path(blocked, false).expect_err("ADS must be rejected");
            assert!(error.contains("ADS") || error.contains("drive"));
        }
    }

    #[test]
    fn relative_path_rejects_windows_device_names_and_aliases() {
        for blocked in [
            "CON",
            "con.txt",
            "folder/AUX.json",
            "NUL ",
            "COM1.log",
            "lpt9",
            "CLOCK$",
            "dir/CONOUT$.txt",
        ] {
            assert!(
                validate_relative_path(blocked, false).is_err(),
                "must reject Windows device {blocked:?}"
            );
        }
        assert!(validate_relative_path("company.txt", false).is_ok());
        assert!(validate_relative_path("com10.txt", false).is_ok());
    }

    #[test]
    fn secret_paths_are_blocked_but_templates_remain_readable() {
        for blocked in [
            ".env",
            ".env.production",
            ".ssh/id_ed25519",
            "config/credentials.json",
            ".git/config",
            "certificates/server.pem",
            "private/signing.key",
        ] {
            assert!(
                validate_relative_path(blocked, false).is_err(),
                "must reject secret path {blocked:?}"
            );
        }
        assert!(validate_relative_path(".env.example", false).is_ok());
        assert!(validate_relative_path("docs/credentials-guide.md", false).is_ok());
    }

    #[test]
    fn expected_sha256_detects_stale_and_missing_versions() {
        let original = b"original content";
        let actual = sha256_bytes(original);
        assert_eq!(
            verify_expected_hash(Some(original), Some(&actual)).expect("matching hash"),
            Some(actual)
        );
        assert!(verify_expected_hash(Some(original), None).is_err());
        assert!(verify_expected_hash(Some(original), Some(&"0".repeat(64))).is_err());
        assert!(verify_expected_hash(None, Some(&sha256_bytes(b"missing"))).is_err());
        assert_eq!(verify_expected_hash(None, None).expect("new file"), None);
    }

    #[test]
    fn mutation_resolution_cannot_leave_the_granted_workspace() {
        let root = temporary_workspace("containment");
        let outside = temporary_workspace("outside");
        let grant = WorkspaceGrant {
            id: "ws_test_grant".to_string(),
            root: root.clone(),
            name: "test".to_string(),
            granted_at_ms: now_ms(),
        };
        let allowed = resolve_mutation_target(&grant, "inside.txt").expect("inside target");
        assert!(allowed.0.starts_with(&root));
        assert!(ensure_contained(&root, &outside).is_err());
        fs::remove_dir_all(root).expect("cleanup root");
        fs::remove_dir_all(outside).expect("cleanup outside");
    }

    #[test]
    fn atomicish_write_replaces_content_without_staging_files() {
        let root = temporary_workspace("atomic");
        let target = root.join("file.txt");
        fs::write(&target, "before").expect("seed file");
        write_atomicish(&target, b"after", "unit-test").expect("atomic replacement");
        assert_eq!(fs::read_to_string(&target).expect("read target"), "after");
        assert!(!root.join(".farsiai-codex-unit-test.new").exists());
        assert!(!root.join(".farsiai-codex-unit-test.old").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn command_run_ids_are_strict_and_script_profiles_reject_inline_code() {
        assert!(validate_run_id("run_12345678").is_ok());
        assert!(validate_run_id("short").is_err());
        assert!(validate_run_id("run has spaces").is_err());

        let root = temporary_workspace("command-profile");
        let grant = WorkspaceGrant {
            id: "ws_command_test".to_string(),
            root: root.clone(),
            name: "test".to_string(),
            granted_at_ms: now_ms(),
        };
        let node = program_profile("node").expect("node profile");
        assert!(validate_command_profile(&node, &["-e".to_string(), "process.exit()".to_string()], &grant).is_err());
        let git = program_profile("git").expect("git profile");
        assert!(validate_command_profile(&git, &["clean".to_string(), "-fdx".to_string()], &grant).is_err());
        assert!(validate_command_profile(&git, &["status".to_string()], &grant).is_ok());
        fs::remove_dir_all(root).expect("cleanup");
    }
}
