use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use std::time::Duration;

const CODEX_PRIMARY_ENDPOINT: &str = "https://farsiai-api.sorniamir2005.workers.dev/v2/codex/turn";
const CODEX_RECOVERY_ENDPOINT: &str = "https://codex-v051-recovery-farsiai-api.sorniamir2005.workers.dev/v2/codex/turn";
const CODEX_PROTOCOL: &str = "farsiai.codex.desktop.v2";
const CODEX_CLIENT_FLAVOR: &str = "codex-studio";
const MAX_REQUEST_BYTES: usize = 5_000_000;
const MAX_RESPONSE_BYTES: usize = 5_000_000;

fn codex_client_header() -> String {
    format!("desktop/{}-{CODEX_CLIENT_FLAVOR}", env!("CARGO_PKG_VERSION"))
}

fn should_failover(status: u16) -> bool {
    matches!(status, 500 | 502 | 503 | 504)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHttpResponse {
    status: u16,
    body: String,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(95))
        .build()
        .map_err(|_| "CODEX_NATIVE_CLIENT_FAILED".to_string())
}

async fn send_turn(
    client: &reqwest::Client,
    endpoint: &str,
    body: &str,
    token: Option<&str>,
) -> Result<CodexHttpResponse, String> {
    let mut request = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header("x-farsiai-client", codex_client_header())
        .header("x-farsiai-codex-protocol", CODEX_PROTOCOL)
        .body(body.to_owned());

    if let Some(token) = token.filter(|value| !value.is_empty() && value.len() <= 16_384) {
        let authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "CODEX_NATIVE_INVALID_TOKEN".to_string())?;
        request = request.header(AUTHORIZATION, authorization);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("CODEX_NATIVE_NETWORK: {error}"))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("CODEX_NATIVE_RESPONSE: {error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("CODEX_NATIVE_RESPONSE_TOO_LARGE".to_string());
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "CODEX_NATIVE_RESPONSE_NOT_UTF8".to_string())?;
    Ok(CodexHttpResponse { status, body })
}

#[tauri::command]
pub async fn codex_api_turn(
    body: String,
    token: Option<String>,
) -> Result<CodexHttpResponse, String> {
    if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
        return Err("CODEX_NATIVE_INVALID_REQUEST".to_string());
    }
    let payload: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "CODEX_NATIVE_INVALID_JSON".to_string())?;
    if !payload.is_object() {
        return Err("CODEX_NATIVE_INVALID_PAYLOAD".to_string());
    }

    let client = build_client()?;
    let token_ref = token.as_deref();

    match send_turn(&client, CODEX_PRIMARY_ENDPOINT, &body, token_ref).await {
        Ok(primary) if should_failover(primary.status) => {
            match send_turn(&client, CODEX_RECOVERY_ENDPOINT, &body, token_ref).await {
                Ok(recovery) => Ok(recovery),
                Err(_) => Ok(primary),
            }
        }
        Ok(primary) => Ok(primary),
        Err(primary_error) => {
            match send_turn(&client, CODEX_RECOVERY_ENDPOINT, &body, token_ref).await {
                Ok(recovery) => Ok(recovery),
                Err(recovery_error) => Err(format!(
                    "CODEX_NATIVE_NETWORK_BOTH: primary={primary_error}; recovery={recovery_error}"
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_client_header_tracks_the_release_version() {
        assert_eq!(codex_client_header(), "desktop/0.5.2-codex-studio");
    }

    #[test]
    fn failover_is_limited_to_upstream_failures() {
        for status in [500, 502, 503, 504] {
            assert!(should_failover(status));
        }
        for status in [200, 400, 401, 403, 404, 409, 429] {
            assert!(!should_failover(status));
        }
    }

    #[test]
    fn native_transport_reaches_the_live_codex_route() {
        let response = tauri::async_runtime::block_on(codex_api_turn("{}".to_string(), None))
            .expect("native Codex transport must reach the primary API");
        assert_eq!(response.status, 401);
        assert!(response.body.contains("CODEX_LOGIN_REQUIRED"));
    }

    #[test]
    fn native_recovery_route_is_live_and_keeps_auth_enabled() {
        let client = build_client().expect("native HTTP client must build");
        let response = tauri::async_runtime::block_on(send_turn(
            &client,
            CODEX_RECOVERY_ENDPOINT,
            "{}",
            None,
        ))
        .expect("native Codex transport must reach the recovery API");
        assert_eq!(response.status, 401);
        assert!(response.body.contains("CODEX_LOGIN_REQUIRED"));
    }
}
