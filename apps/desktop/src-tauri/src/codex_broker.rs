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
            ×½»öÚ$z{-®éÜj×VB6öÖÖæC¢¶W'&÷'Ò"’“ó°¢ÆWB7FF÷WBÒ6†–Æ@¢ç7FF÷W@¢çF¶R‚¢æöµö÷%öVÇ6R‡ÇÂ$6ææ÷B6GW&R6öÖÖæB7FF÷WBâ"çFõ÷7G&–ær‚’“ó°¢ÆWB7FFW'"Ò6†–Æ@¢ç7FFW' ¢çF¶R‚¢æöµö÷%öVÇ6R‡ÇÂ$6ææ÷B6GW&R6öÖÖæB7FFW'"â"çFõ÷7G&–ær‚’“ó°¢ÆWB7FF÷WE÷&VFW"ÒF‡&VC£§7vâ†Ö÷fRÇÂG&–åö&÷VæFVB‡7FF÷WB’“°¢ÆWB7FFW'%÷&VFW"ÒF‡&VC£§7vâ†Ö÷fRÇÂG&–åö&÷VæFVB‡7FFW'"’“° ¢ÆWB×WBF–ÖVEö÷WBÒfÇ6S°¢ÆWB×WB6æ6VÆÆVBÒfÇ6S°¢ÆWBW†—E÷7FGW2ÒÆö÷°¢–b6æ6VÂæÆöB„÷&FW&–æs£¤7V—&R’°¢6æ6VÆÆVBÒG'VS°¢FW&Ö–æFU÷&ö6W75÷G&VR‚f×WB6†–ÆB“°¢'&V²6†–ÆBçv—B‚’æö²‚“°¢Ð¢–b7F'FVBæVÆ6VB‚’ãÒGW&F–öã£¦g&öÕöÖ–ÆÆ—2‡F–ÖV÷WEö×2’°¢F–ÖVEö÷WBÒG'VS°¢FW&Ö–æFU÷&ö6W75÷G&VR‚f×WB6†–ÆB“°¢'&V²6†–ÆBçv—B‚’æö²‚“°¢Ð¢ÖF6‚6†–ÆBçG'•÷v—B‚’°¢ö²…6öÖR‡7FGW2’’Óâ'&V²6öÖR‡7FGW2’À¢ö²„æöæR’ÓâF‡&VC£§6ÆVW„GW&F–öã£¦g&öÕöÖ–ÆÆ—2ƒ#R’’À¢W'"†W'&÷"’Óâ°¢FW&Ö–æFU÷&ö6W75÷G&VR‚f×WB6†–ÆB“°¢ÆWBòÒ6†–ÆBçv—B‚“°¢&WGW&âW'"†f÷&ÖB‚$6ææ÷BÖöæ—F÷"&÷fVB6öÖÖæC¢¶W'&÷'Ò"’“°¢Ð¢Ð¢Ó° ¢ÆWB‡7FF÷WBÂ7FF÷WE÷G'Væ6FVB’Ò7FF÷WE÷&VFW ¢æ¦ö–â‚¢æÖöW'"‡Å÷Â'7FF÷WB6GW&Rv÷&¶W"f–ÆVBâ"çFõ÷7G&–ær‚’“ó°¢ÆWB‡7FFW'"Â7FFW'%÷G'Væ6FVB’Ò7FFW'%÷&VFW ¢æ¦ö–â‚¢æÖöW'"‡Å÷Â'7FFW'"6GW&Rv÷&¶W"f–ÆVBâ"çFõ÷7G&–ær‚’“ó°¢ÆWB×WB7FF÷WBÒ7G&–æs£¦g&öÕ÷WFc…öÆ÷77’‚g7FF÷WB’çFõ÷7G&–ær‚“°¢ÆWB×WB7FFW'"Ò7G&–æs£¦g&öÕ÷WFc…öÆ÷77’‚g7FFW'"’çFõ÷7G&–ær‚“°¢–b7FF÷WE÷G'Væ6FVB°¢7FF÷WBçW6…÷7G"‚%Æâââå·7FF÷WBG'Væ6FVB'’f'6”’6öFW…Ò"“°¢Ð¢–b7FFW'%÷G'Væ6FVB°¢7FFW'"çW6…÷7G"‚%Æâââå·7FFW'"G'Væ6FVB'’f'6”’6öFW…Ò"“°¢Ð¢ö²„6öÖÖæDW†V7WF–öå&W7VÇB°¢'Våö–BÀ¢&öw&ÒÀ¢W†V7WF&ÆU÷Fƒ¢F…öf÷%öF—7Æ’‚fW†V7WF&ÆR’À¢7FF÷WBÀ¢7FFW'"À¢W†—Eö6öFS¢W†—E÷7FGW2ææE÷F†Vâ‡Ç7FGW7Â7FGW2æ6öFR‚’’À¢GW&F–öåö×3¢7F'FVBæVÆ6VB‚’æ5öÖ–ÆÆ—2‚’çG'•ö–çFò‚’çVçw&ö÷"‡ScC£¤Ô‚’À¢F–ÖVEö÷WBÀ¢6æ6VÆÆVBÀ¢÷WGWE÷G'Væ6FVC¢7FF÷WE÷G'Væ6FVBÇÂ7FFW'%÷G'Væ6FVBÀ¢Ò§Ð ¢5·FW&“£¦6öÖÖæB‡&VæÖUöÆÂÒ&6ÖVÄ66R"•Ð§V"7–æ2fâ6öFW…÷'Våö6öÖÖæB€¢v÷&·76Uö–C¢7G&–ærÀ¢'Våö–C¢7G&–ærÀ¢&öw&Ó¢7G&–ærÀ¢&w3¢fV3Å7G&–æsâÀ¢7vC¢÷F–öãÅ7G&–æsâÀ¢F–ÖV÷WEö×3¢÷F–öãÇScCâÀ¢&V6öã¢÷F–öãÅ7G&–æsâÀ¢¢†æFÆRÀ¢7FFS¢7FFSÂuòÂ6öFW…7FFSâÀ¢’Óâ&W7VÇCÄ6öÖÖæDW†V7WF–öå&W7VÇBÂ7G&–æsâ°¢fÆ–FFU÷'Våö–B‚g'Våö–B“ó°¢ÆWBæ÷&ÖÆ—¦VE÷&öw&ÒÒ&öw&ÒçG&–Ò‚’çFõö66–•öÆ÷vW&66R‚“°¢–bæ÷&ÖÆ—¦VE÷&öw&ÒÒ&öw&ÒçG&–Ò‚¢ÇÂæ÷&ÖÆ—¦VE÷&öw&Òæ—5öV×G’‚¢ÇÂæ÷&ÖÆ—¦VE÷&öw&Ð¢æ'—FW2‚¢æÆÂ‡ÇfÇVWÂfÇVRæ—5ö66–•öÆ÷vW&66R‚’ÇÂfÇVRæ—5ö66–•öF–v—B‚’¢°¢&WGW&âW'"‚%&öw&Ò×W7B&RâW†7BÆ÷vW&66RW†V7WF&ÆR&öf–ÆRæÖRâ"çFõ÷7G&–ær‚’“°¢Ð¢ÆWB&öf–ÆRÒ&öw&Õ÷&öf–ÆR‚fæ÷&ÖÆ—¦VE÷&öw&Ò¢æöµö÷%öVÇ6R‡ÇÂ%&öw&Ò—2æ÷B–âF†R6öFW‚6öÖÖæB&öf–ÆRÆÆ÷vÆ—7Bâ"çFõ÷7G&–ær‚’“ó°¢ÆWBw&çBÒvWE÷v÷&·76R‚g7FFRÂgv÷&·76Uö–B“ó°¢fÆ–FFUö6öÖÖæE÷&öf–ÆR‚g&öf–ÆRÂf&w2Âfw&çB“ó°¢ÆWB&WVW7FVEö7vBÒ7vBçVçw&ö÷%öFVfVÇB‚“°¢ÆWB‡v÷&¶–æuöF—&V7F÷'’Âæ÷&ÖÆ—¦VEö7vB’Ð¢&W6öÇfUöW†—7F–ær‚fw&çBÂg&WVW7FVEö7vBÂG'VR“ó°¢–bv÷&¶–æuöF—&V7F÷'’æ—5öF—"‚’°¢&WGW&âW'"‚$6öÖÖæBv÷&¶–ærF—&V7F÷'’—2æ÷BF—&V7F÷'’â"çFõ÷7G&–ær‚’“°¢Ð¢ÆWBF–ÖV÷WEö×2ÒF–ÖV÷WEö×2çVçw&ö÷"ƒ#ó“°¢–b„Ô”åô4ôÔÔäEõD”ÔTõUEôÕ2âãÔÔ…ô4ôÔÔäEõD”ÔTõUEôÕ2’æ6öçF–ç2‚gF–ÖV÷WEö×2’°¢&WGW&âW'"†f÷&ÖB€¢'F–ÖV÷WD×2×W7B&R&WGvVVâ´Ô”åô4ôÔÔäEõD”ÔTõUEôÕ7ÒæB´Ô…ô4ôÔÔäEõD”ÔTõUEôÕ7Òâ ¢’“°¢Ð¢ÆWBW†V7WF&ÆRÒ&W6öÇfUöW†V7WF&ÆR‚g&öf–ÆRÂfw&çBç&ö÷B“ó°¢ÆWBw&W"ÒW†V7WF&ÆP¢æW‡FVç6–öâ‚¢ææE÷F†Vâ‡ÇfÇVWÂfÇVRçFõ÷7G"‚’¢æ—5÷6öÖUöæB‡ÆW‡FVç6–öçÂ°¢W‡FVç6–öâæWö–væ÷&Uö66–•ö66R‚&6ÖB"’ÇÂW‡FVç6–öâæWö–væ÷&Uö66–•ö66R‚&&B"¢Ò“°¢fÆ–FFU÷&ö6W75ö&w2‚f&w2Âw&W"“ó°¢ÆWBW†V7WF&ÆUöÖWFFFÒg3£¦ÖWFFF‚fW†V7WF&ÆR¢æÖöW'"‡ÆW'&÷'Âf÷&ÖB‚$6ææ÷B–ç7V7B&÷fVBW†V7WF&ÆS¢¶W'&÷'Ò"’“ó°¢ÆWBW†V7WF&ÆUö–FVçF—G’Ò†W†V7WF&ÆUöÖWFFFæÆVâ‚’ÂÖöF–f–VEö×2‚fW†V7WF&ÆUöÖWFFF’“°¢ÆWB&w5÷&Wf–WrÒ–b&w2æ—5öV×G’‚’°¢"ŠŠý˜˜bŠ-‹ªý˜˜]Š}˜b’"çFõ÷7G&–ær‚¢ÒVÇ6R°¢&w2æ—FW"‚¢æÖ‡ÇfÇVWÂ6VEöFWF–Â‡fÇVR’¢æ6öÆÆV7C££ÅfV3Åóãâ‚¢æ¦ö–â‚""¢Ó°¢ÆWB&V6öâÒ&V6öà¢æf–ÇFW"‡ÇfÇVWÂfÇVRçG&–Ò‚’æ—5öV×G’‚’¢æÖ†6VEöFWF–Â¢çVçw&ö÷%öVÇ6R‡ÇÂ-Š‹‹‹=¸Â¸ÍŠrŠ­‹=Š¢›í‹˜©˜rŠ­˜‹=‹r6öFW‚"çFõ÷7G&–ær‚’“°¢–bæF—fUö6öæf—&Ò€¢fÀ¢$f'6”’6öFW‚(	BŠ­Š=¸Í¸ÍŠòŠ}ŠÍ‹Š}¸ÂŠý‹=Š­˜‹"À¢f÷&ÖB€¢$6öFW‚˜]¸Î(ÍŠí˜Š}˜}Šò¸Íª’Šý‹=Š­˜‹ª˜mŠ­‹˜N(Í‹MŠý˜rŠ}ŠÍ‹Šrª˜mŠó¥ÆåÆí›í‹˜˜Š}¸Í˜C¢·ÕÆí˜Š}¸Í˜BŠ}ŠÍ‹Š}¸Í¸Ã¢·ÕÆí›í˜‹M˜s¢·ÕÆíŠ-‹ªý˜˜]Š}˜n(Í˜}Šs¢·ÕÆí˜]˜}˜MŠ£¢·ÒŠ½Š}˜m¸Í˜uÆíŠý˜M¸Í˜C¢·ÕÆåÆí›í˜‹=Š­˜}™BŠ-‹-Š}Šò˜‚˜‹˜Šý¸ÂŠ­‹Š}˜]˜M¸Â‹­¸Í‹˜‹Š}˜BŠ}‹=Š¢â"À¢&öf–ÆRæÆ&VÂÀ¢F…öf÷%öF—7Æ’‚fW†V7WF&ÆR’À¢æ÷&ÖÆ—¦U÷&VÆF—fUöf÷%÷&W7VÇB‚fæ÷&ÖÆ—¦VEö7vB’À¢&w5÷&Wf–WrÀ¢F–ÖV÷WEö×2òóÀ¢&V6öà¢’À¢’°¢W6…öVF—B€¢g7FFRÀ¢&6öÖÖæBç'Vâ"À¢&6æ6VÆÆVB"À¢6öÖR‚gv÷&·76Uö–B’À¢6öÖR‚fæ÷&ÖÆ—¦VE÷&öw&Ò’À¢6öÖR†f÷&ÖB‚''Vâ·'Våö–GÒ"’’À¢“°¢&WGW&âW'"‚$6öÖÖæBW†V7WF–öâv26æ6VÆÆVB'’F†RW6W"â"çFõ÷7G&–ær‚’“°¢Ð ¢ÆWB6æöæ–6ÅöW†V7WF&ÆRÒg3£¦6æöæ–6Æ—¦R‚fW†V7WF&ÆR¢æÖöW'"‡Å÷Â$W†V7WF&ÆRF—6V&VBv†–ÆRW&Ö—76–öâv2&V–ær6öæf—&ÖVBâ"çFõ÷7G&–ær‚’“ó°¢ÆWB&Vg&W6†VEöÖWFFFÒg3£¦ÖWFFF‚f6æöæ–6ÅöW†V7WF&ÆR¢æÖöW'"‡ÆW'&÷'Âf÷&ÖB‚$6ææ÷B&RÖ6†V6²&÷fVBW†V7WF&ÆS¢¶W'&÷'Ò"’“ó°¢–b6æöæ–6ÅöW†V7WF&ÆRÒW†V7WF&ÆP¢ÇÂ‡&Vg&W6†VEöÖWFFFæÆVâ‚’ÂÖöF–f–VEö×2‚g&Vg&W6†VEöÖWFFF’’ÒW†V7WF&ÆUö–FVçF—G¢°¢&WGW&âW'"‚$W†V7WF&ÆR6†ævVBv†–ÆRW&Ö—76–öâv2&V–ær6öæf—&ÖVC²'Vâ&÷'FVBâ"çFõ÷7G&–ær‚’“°¢Ð¢ÆWB&Vg&W6†VEö7vBÒg3£¦6æöæ–6Æ—¦R‚gv÷&¶–æuöF—&V7F÷'’¢æÖöW'"‡Å÷Â%v÷&¶–ærF—&V7F÷'’F—6V&VB&Vf÷&R6öÖÖæBW†V7WF–öââ"çFõ÷7G&–ær‚’“ó°¢Vç7W&Uö6öçF–æVB‚fw&çBç&ö÷BÂg&Vg&W6†VEö7vB“ó° ¢ÆWB6æ6VÂÒ&3£¦æWr„FöÖ–4&ööÃ£¦æWr†fÇ6R’“°¢°¢ÆWB×WB'Vç2Ò7FFRç'Vç2æÆö6²‚’æÖöW'"‡Å÷ÂÆö6µöW'&÷"‚$6öÖÖæB'Vâ"’“ó°¢–b'Vç2æ6öçF–ç5ö¶W’‚g'Våö–B’°¢&WGW&âW'"‚''Vä–B—2Ç&VG’7F—fRâ"çFõ÷7G&–ær‚’“°¢Ð¢'Vç2æ–ç6W'B€¢'Våö–Bæ6ÆöæR‚’À¢7F—fU'Vâ°¢6æ6VÃ¢6æ6VÂæ6ÆöæR‚’À¢ÒÀ¢“°¢Ð¢W6…öVF—B€¢g7FFRÀ¢&6öÖÖæBç'Vâ"À¢'7F'FVB"À¢6öÖR‚gv÷&·76Uö–B’À¢6öÖR‚fæ÷&ÖÆ—¦VE÷&öw&Ò’À¢6öÖR†f÷&ÖB‚''Vâ·'Våö–GÒ"’’À¢“° ¢ÆWBv÷&¶W%÷'Våö–BÒ'Våö–Bæ6ÆöæR‚“°¢ÆWBv÷&¶W%÷&öw&ÒÒæ÷&ÖÆ—¦VE÷&öw&Òæ6ÆöæR‚“°¢ÆWBv÷&¶W%öW†V7WF&ÆRÒW†V7WF&ÆRæ6ÆöæR‚“°¢ÆWB&W7VÇBÒFW&“£¦7–æ5÷'VçF–ÖS£§7våö&Æö6¶–ær†Ö÷fRÇÂ°¢W†V7WFUö6öÖÖæE÷&ö6W72€¢v÷&¶W%÷'Våö–BÀ¢v÷&¶W%÷&öw&ÒÀ¢v÷&¶W%öW†V7WF&ÆRÀ¢&w2À¢&Vg&W6†VEö7vBÀ¢F–ÖV÷WEö×2À¢6æ6VÂÀ¢¢Ò¢æv—@¢æÖöW'"‡ÆW'&÷'Âf÷&ÖB‚$6öÖÖæBv÷&¶W"f–ÆVC¢¶W'&÷'Ò"’“°¢–bÆWBö²†×WB'Vç2’Ò7FFRç'Vç2æÆö6²‚’°¢'Vç2ç&VÖ÷fR‚g'Våö–B“°¢Ð¢ÆWB&W7VÇBÒ&W7VÇCóó°¢ÆWB÷WF6öÖRÒ–b&W7VÇBæ6æ6VÆÆVB°¢&6æ6VÆÆVB ¢ÒVÇ6R–b&W7VÇBçF–ÖVEö÷WB°¢'F–ÖVEö÷WB ¢ÒVÇ6R–b&W7VÇBæW†—Eö6öFRÓÒ6öÖRƒ’°¢&6ö×ÆWFVB ¢ÒVÇ6R°¢&f–ÆVB ¢Ó°¢W6…öVF—B€¢g7FFRÀ¢&6öÖÖæBç'Vâ"À¢÷WF6öÖRÀ¢6öÖR‚gv÷&·76Uö–B’À¢6öÖR‚fæ÷&ÖÆ—¦VE÷&öw&Ò’À¢6öÖR†f÷&ÖB€¢''Vâ·'Våö–GÒÂW†—B³£÷ÒÂ·Ò×2"À¢&W7VÇBæW†—Eö6öFRÂ&W7VÇBæGW&F–öåö×0¢’’À¢“°¢ö²‡&W7VÇB§Ð ¢5·FW&“£¦6öÖÖæB‡&VæÖUöÆÂÒ&6ÖVÄ66R"•Ð§V"fâ6öFW…ö6æ6VÅ÷'Vâ€¢'Våö–C¢7G&–ærÀ¢7FFS¢7FFSÂuòÂ6öFW…7FFSâÀ¢’Óâ&W7VÇCÄ6æ6VÅ'Vå&W7VÇBÂ7G&–æsâ°¢fÆ–FFU÷'Våö–B‚g'Våö–B“ó°¢ÆWBf÷VæBÒ°¢ÆWB'Vç2Ò7FFRç'Vç2æÆö6²‚’æÖöW'"‡Å÷ÂÆö6µöW'&÷"‚$6öÖÖæB'Vâ"’“ó°¢–bÆWB6öÖR†7F—fR’Ò'Vç2ævWB‚g'Våö–B’°¢7F—fRæ6æ6VÂç7F÷&R‡G'VRÂ÷&FW&–æs£¥&VÆV6R“°¢G'VP¢ÒVÇ6R°¢fÇ6P¢Ð¢Ó°¢W6…öVF—B€¢g7FFRÀ¢&6öÖÖæBæ6æ6VÂ"À¢–bf÷VæB²'&WVW7FVB"ÒVÇ6R²&æ÷Eöf÷VæB"ÒÀ¢æöæRÀ¢6öÖR‚g'Våö–B’À¢æöæRÀ¢“°¢ö²„6æ6VÅ'Vå&W7VÇB²'Våö–BÂf÷VæBÒ§Ð ¢5·FW&“£¦6öÖÖæB‡&VæÖUöÆÂÒ&6ÖVÄ66R"•Ð§V"fâ6öFW…öÆ—7EöVF—B€¢Æ–Ö—C¢÷F–öãÇW6—¦SâÀ¢7FFS¢7FFSÂuòÂ6öFW…7FFSâÀ¢’Óâ&W7VÇCÅfV3ÄVF—DWfVçCâÂ7G&–æsâ°¢ÆWBÆ–Ö—BÒÆ–Ö—BçVçw&ö÷"ƒ“°¢–bÆ–Ö—BÓÒÇÂÆ–Ö—BâÔ…ôTD•EôUdTåE2°¢&WGW&âW'"†f÷&ÖB‚&Æ–Ö—B×W7B&R&WGvVVâæB´Ô…ôTD•EôUdTåE7Òâ"’“°¢Ð¢ÆWBWfVçG2Ò7FFRæVF—BæÆö6²‚’æÖöW'"‡Å÷ÂÆö6µöW'&÷"‚$VF—B"’“ó°¢ö²†WfVçG2æ—FW"‚’ç&Wb‚’çF¶R†Æ–Ö—B’æ6ÆöæVB‚’æ6öÆÆV7B‚’§Ð ¢5¶6fr‡FW7B•Ð¦ÖöBFW7G2°¢W6R7WW#£¢£° ¢fâFV×÷&'•÷v÷&·76R†Æ&VÃ¢g7G"’ÓâF„'Vb°¢ÆWBF‚ÒVçc£§FV×öF—"‚’æ¦ö–â†f÷&ÖB‚&f'6–’Ö6öFW‚Ö'&ö¶W"×¶Æ&VÇÒ×·Ò"ÂæWuö–B‚'FW7B"’’“°¢g3£¦7&VFUöF—%öÆÂ‚gF‚’æW‡V7B‚&7&VFRFV×÷&'’v÷&·76R"“°¢g3£¦6æöæ–6Æ—¦R‡F‚’æW‡V7B‚&6æöæ–6ÂFV×÷&'’v÷&·76R"¢Ð ¢5·FW7EÐ¢fâ&VÆF—fU÷F…÷&V¦V7G5öÆÅ÷G&fW'6ÅöæEö'6öÇWFUöf÷&×2‚’°¢f÷"&Æö6¶VB–â°¢"ââö÷WG6–FRçG‡B"À¢'6fRòââòââö÷WG6–FRçG‡B"À¢"'6fUÂâåÆ÷WG6–FRçG‡B"À¢"$3¥Æ÷WG6–FRçG‡B"À¢"%ÅÇ6W'fW%Ç6†&UÆf–ÆRçG‡B"À¢"öWF2÷77vB"À¢'6fRòöf–ÆRçG‡B"À¢"'6fUÅÆf–ÆRçG‡B"À¢Ò°¢76W'B€¢fÆ–FFU÷&VÆF—fU÷F‚†&Æö6¶VBÂfÇ6R’æ—5öW'"‚’À¢&×W7B&V¦V7B¶&Æö6¶VC£÷Ò ¢“°¢Ð¢76W'B‡fÆ–FFU÷&VÆF—fU÷F‚‚'7&2ö6ö×öæVçG2ôçG7‚"ÂfÇ6R’æ—5öö²‚’“°¢Ð ¢5·FW7EÐ¢fâ&VÆF—fU÷F…÷&V¦V7G5öçFg5öÇFW&æFUöFF÷7G&V×2‚’°¢f÷"&Æö6¶VB–â²&æ÷FW2çG‡C§–ÆöB"Â&föÆFW"öf–ÆRæ§3¢DDD"Â&¦#¦2%Ò°¢ÆWBW'&÷"ÒfÆ–FFU÷&VÆF—fU÷F‚†&Æö6¶VBÂfÇ6R’æW‡V7EöW'"‚$E2×W7B&R&V¦V7FVB"“°¢76W'B†W'&÷"æ6öçF–ç2‚$E2"’ÇÂW'&÷"æ6öçF–ç2‚&G&—fR"’“°¢Ð¢Ð ¢5·FW7EÐ¢fâ&VÆF—fU÷F…÷&V¦V7G5÷v–æF÷w5öFWf–6UöæÖW5öæEöÆ–6W2‚’°¢f÷"&Æö6¶VB–â°¢$4ôâ"À¢&6öâçG‡B"À¢&föÆFW"ôU‚æ§6öâ"À¢$åTÂ"À¢$4ôÓæÆör"À¢&ÇC’"À¢$4Äô4²B"À¢&F—"ô4ôäõUBBçG‡B"À¢Ò°¢76W'B€¢fÆ–FFU÷&VÆF—fU÷F‚†&Æö6¶VBÂfÇ6R’æ—5öW'"‚’À¢&×W7B&V¦V7Bv–æF÷w2FWf–6R¶&Æö6¶VC£÷Ò ¢“°¢Ð¢76W'B‡fÆ–FFU÷&VÆF—fU÷F‚‚&6ö×ç’çG‡B"ÂfÇ6R’æ—5öö²‚’“°¢76W'B‡fÆ–FFU÷&VÆF—fU÷F‚‚&6öÓçG‡B"ÂfÇ6R’æ—5öö²‚’“°¢Ð ¢5·FW7EÐ¢fâ6V7&WE÷F‡5ö&Uö&Æö6¶VEö'WE÷FV×ÆFW5÷&VÖ–å÷&VF&ÆR‚’°¢f÷"&Æö6¶VB–â°¢"æVçb"À¢"æVçbç&öGV7F–öâ"À¢"ç76‚ö–EöVC#SS’"À¢&6öæf–rö7&VFVçF–Ç2æ§6öâ"À¢"æv—Bö6öæf–r"À¢&6W'F–f–6FW2÷6W'fW"çVÒ"À¢'&—fFR÷6–væ–æræ¶W’"À¢Ò°¢76W'B€¢fÆ–FFU÷&VÆF—fU÷F‚†&Æö6¶VBÂfÇ6R’æ—5öW'"‚’À¢&×W7B&V¦V7B6V7&WBF‚¶&Æö6¶VC£÷Ò ¢“°¢Ð¢76W'B‡fÆ–FFU÷&VÆF—fU÷F‚‚"æVçbæW†×ÆR"ÂfÇ6R’æ—5öö²‚’“°¢76W'B‡fÆ–FFU÷&VÆF—fU÷F‚‚&Fö72ö7&VFVçF–Ç2ÖwV–FRæÖB"ÂfÇ6R’æ—5öö²‚’“°¢Ð ¢5·FW7EÐ¢fâW‡V7FVE÷6†#SeöFWFV7G5÷7FÆUöæEöÖ—76–æu÷fW'6–öç2‚’°¢ÆWB÷&–v–æÂÒ"&÷&–v–æÂ6öçFVçB#°¢ÆWB7GVÂÒ6†#Seö'—FW2†÷&–v–æÂ“°¢76W'EöW€¢fW&–g•öW‡V7FVEö†6‚…6öÖR†÷&–v–æÂ’Â6öÖR‚f7GVÂ’’æW‡V7B‚&ÖF6†–ær†6‚"’À¢6öÖR†7GVÂ¢“°¢76W'B‡fW&–g•öW‡V7FVEö†6‚…6öÖR†÷&–v–æÂ’ÂæöæR’æ—5öW'"‚’“°¢76W'B‡fW&–g•öW‡V7FVEö†6‚…6öÖR†÷&–v–æÂ’Â6öÖR‚b#"ç&WVBƒcB’’’æ—5öW'"‚’“°¢76W'B‡fW&–g•öW‡V7FVEö†6‚„æöæRÂ6öÖR‚g6†#Seö'—FW2†"&Ö—76–ær"’’’æ—5öW'"‚’“°¢76W'EöW‡fW&–g•öW‡V7FVEö†6‚„æöæRÂæöæR’æW‡V7B‚&æWrf–ÆR"’ÂæöæR“°¢Ð ¢5·FW7EÐ¢fâ×WFF–öå÷&W6öÇWF–öåö6ææ÷EöÆVfU÷F†Uöw&çFVE÷v÷&·76R‚’°¢ÆWB&ö÷BÒFV×÷&'•÷v÷&·76R‚&6öçF–æÖVçB"“°¢ÆWB÷WG6–FRÒFV×÷&'•÷v÷&·76R‚&÷WG6–FR"“°¢ÆWBw&çBÒv÷&·76Tw&çB°¢–C¢'w5÷FW7Eöw&çB"çFõ÷7G&–ær‚’À¢&ö÷C¢&ö÷Bæ6ÆöæR‚’À¢æÖS¢'FW7B"çFõ÷7G&–ær‚’À¢w&çFVEöEö×3¢æ÷uö×2‚’À¢Ó°¢ÆWBÆÆ÷vVBÒ&W6öÇfUö×WFF–öå÷F&vWB‚fw&çBÂ&–ç6–FRçG‡B"’æW‡V7B‚&–ç6–FRF&vWB"“°¢76W'B†ÆÆ÷vVBãç7F'G5÷v—F‚‚g&ö÷B’“°¢76W'B†Vç7W&Uö6öçF–æVB‚g&ö÷BÂf÷WG6–FR’æ—5öW'"‚’“°¢g3£§&VÖ÷fUöF—%öÆÂ‡&ö÷B’æW‡V7B‚&6ÆVçW&ö÷B"“°¢g3£§&VÖ÷fUöF—%öÆÂ†÷WG6–FR’æW‡V7B‚&6ÆVçW÷WG6–FR"“°¢Ð ¢5·FW7EÐ¢fâFöÖ–6—6…÷w&—FU÷&WÆ6W5ö6öçFVçE÷v—F†÷WE÷7Fv–æuöf–ÆW2‚’°¢ÆWB&ö÷BÒFV×÷&'•÷v÷&·76R‚&FöÖ–2"“°¢ÆWBF&vWBÒ&ö÷Bæ¦ö–â‚&f–ÆRçG‡B"“°¢g3£§w&—FR‚gF&vWBÂ&&Vf÷&R"’æW‡V7B‚'6VVBf–ÆR"“°¢w&—FUöFöÖ–6—6‚‚gF&vWBÂ"&gFW""Â'Væ—B×FW7B"’æW‡V7B‚&FöÖ–2&WÆ6VÖVçB"“°¢76W'EöW†g3£§&VE÷Fõ÷7G&–ær‚gF&vWB’æW‡V7B‚'&VBF&vWB"’Â&gFW""“°¢76W'B‚&ö÷Bæ¦ö–â‚"æf'6–’Ö6öFW‚×Væ—B×FW7BææWr"’æW†—7G2‚’“°¢76W'B‚&ö÷Bæ¦ö–â‚"æf'6–’Ö6öFW‚×Væ—B×FW7BæöÆB"’æW†—7G2‚’“°¢g3£§&VÖ÷fUöF—%öÆÂ‡&ö÷B’æW‡V7B‚&6ÆVçW"“°¢Ð ¢5·FW7EÐ¢fâ6öÖÖæE÷'Våö–G5ö&U÷7G&–7EöæE÷67&—E÷&öf–ÆW5÷&V¦V7Eö–æÆ–æUö6öFR‚’°¢76W'B‡fÆ–FFU÷'Våö–B‚''Våó#3CScs‚"’æ—5öö²‚’“°¢76W'B‡fÆ–FFU÷'Våö–B‚'6†÷'B"’æ—5öW'"‚’“°¢76W'B‡fÆ–FFU÷'Våö–B‚''Vâ†276W2"’æ—5öW'"‚’“° ¢ÆWB&ö÷BÒFV×÷&'•÷v÷&·76R‚&6öÖÖæB×&öf–ÆR"“°¢ÆWBw&çBÒv÷&·76Tw&çB°¢–C¢'w5ö6öÖÖæE÷FW7B"çFõ÷7G&–ær‚’À¢&ö÷C¢&ö÷Bæ6ÆöæR‚’À¢æÖS¢'FW7B"çFõ÷7G&–ær‚’À¢w&çFVEöEö×3¢æ÷uö×2‚’À¢Ó°¢ÆWBæöFRÒ&öw&Õ÷&öf–ÆR‚&æöFR"’æW‡V7B‚&æöFR&öf–ÆR"“°¢76W'B‡fÆ–FFUö6öÖÖæE÷&öf–ÆR‚fæöFRÂe²"ÖR"çFõ÷7G&–ær‚’Â'&ö6W72æW†—B‚’"çFõ÷7G&–ær‚•ÒÂfw&çB’æ—5öW'"‚’“°¢ÆWBv—BÒ&öw&Õ÷&öf–ÆR‚&v—B"’æW‡V7B‚&v—B&öf–ÆR"“°¢76W'B‡fÆ–FFUö6öÖÖæE÷&öf–ÆR‚fv—BÂe²&6ÆVâ"çFõ÷7G&–ær‚’Â"ÖfG‚"çFõ÷7G&–ær‚•ÒÂfw&çB’æ—5öW'"‚’“°¢76W'B‡fÆ–FFUö6öÖÖæE÷&öf–ÆR‚fv—BÂe²'7FGW2"çFõ÷7G&–ær‚•ÒÂfw&çB’æ—5öö²‚’“°¢g3£§&VÖ÷fUöF—%öÆÂ‡&ö÷B’æW‡V7B‚&6ÆVçW"“°¢Ð§Ð