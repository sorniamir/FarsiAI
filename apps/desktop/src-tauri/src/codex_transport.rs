use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use std::time::Duration;

const CODEX_ENDPOINT: &str = "https://farsiai-api.sorniamir2005.workers.dev/v2/codex/turn";
const CODEX_PROTOCOL: &str = "farsiai.codex.desktop.v2";
const MAX_REQUEST_BYTES: usize = 5_000_000;
const MAX_RESPONSE_BYTES: usize = 5_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHttpResponse {
    status: u16,
    body: String,
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

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(95))
        .build()
        .map_err(|_| "CODEX_NATIVE_CLIENT_FAILED".to_string())?;
    let mut request = client
        .post(CODEX_ENDPOINT)
        .header(CONTENT_TYPE, "application/json")
        .header("x-farsiai-client", "desktop/0.5.0-codex-studio")
        .header("x-farsiai-codex-protocol", CODEX_PROTOCOL)
        .body(body);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_transport_reaches_the_live_codex_route() {
        let response = tauri::async_runtime::block_on(codex_api_turn("{}".to_string(), None))
            .expect("native Codex transport must reach the production API");
        assert_eq!(response.status, 401);
        assert!(response.body.contains("CODEX_LOGIN_REQUIRED"));
    }
}
