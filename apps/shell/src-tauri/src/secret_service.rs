//! 给运行时用的极简加密服务。
//!
//! 为什么需要它：界面跑在 `http://127.0.0.1:47900`，拿不到 Tauri IPC，
//! 所以运行时（Node）无法直接调用壳里的 `encrypt_secret` 命令。
//!
//! 这里在**另一个只监听回环的端口**上暴露两个接口：
//!
//! ```text
//! POST /encrypt  {"plain":"..."} → {"cipher":"..."}
//! POST /decrypt  {"cipher":"..."} → {"plain":"..."}
//! ```
//!
//! 安全约束：
//! - 只监听 `127.0.0.1`，外部网络访问不到；
//! - **必须带共享令牌**（启动时随机生成、只通过环境变量交给自己拉起的运行时），
//!   防止同机其它程序调用；
//! - 接口只做加解密，不提供通用能力。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;

/// 共享令牌：由壳生成，通过环境变量传给运行时。
static TOKEN: OnceLock<String> = OnceLock::new();

pub fn set_token(token: String) {
    let _ = TOKEN.set(token);
}

fn token_matches(candidate: &str) -> bool {
    match TOKEN.get() {
        Some(expected) => {
            // 定时安全比较：长度不同直接 false，避免泄露长度。
            if candidate.len() != expected.len() {
                return false;
            }
            let mut diff = 0u8;
            for (a, b) in candidate.bytes().zip(expected.bytes()) {
                diff |= a ^ b;
            }
            diff == 0
        }
        None => false,
    }
}

/// 在指定端口启动服务（后台线程）。失败只记日志，不影响主程序。
pub fn serve(port: u16) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(error) => {
                // 端口被占不影响主程序：运行时那边会退回到"不加密"并给出提示。
                eprintln!("密钥加密服务启动失败（端口 {port}）：{error}");
                return;
            }
        };

        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = handle(stream);
            });
        }
    });
}

fn handle(mut stream: TcpStream) -> std::io::Result<()> {
    // 先读到请求头结束，再按 Content-Length 读完 body。
    // 只读一次 8KB 会在密钥较长时截断请求体，导致 JSON 解析失败——
    // 这种"偶发失败"最难查。
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end;

    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return respond(&mut stream, 400, r#"{"error":"请求不完整"}"#);
        }
        raw.extend_from_slice(&chunk[..read]);

        if let Some(position) = find_header_end(&raw) {
            header_end = position;
            break;
        }
        if raw.len() > 64 * 1024 {
            return respond(&mut stream, 413, r#"{"error":"请求头过大"}"#);
        }
    }

    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();

    let mut authorized = false;
    let mut content_length = 0usize;
    let mut received_token = String::new();

    for line in lines {
        let lower = line.to_ascii_lowercase();
        // 注意：**值必须从原始行取**。
        // 早期版本从 `lower` 里取值，令牌被整体转成小写，
        // 于是正确的令牌也永远匹配不上（表现为"缺少或错误的令牌"，很难查）。
        let Some((_, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if lower.starts_with("authorization:") {
            received_token = value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .unwrap_or(value)
                .to_string();
            authorized = token_matches(&received_token);
        } else if lower.starts_with("content-length:") {
            content_length = value.parse().unwrap_or(0);
        }
    }

    if method != "POST" {
        return respond(&mut stream, 405, r#"{"error":"只接受 POST"}"#);
    }
    if !authorized {
        // 诊断日志：只记录长度，不记录令牌内容。
        let expected_len = TOKEN.get().map(|t| t.len()).unwrap_or(0);
        crate::append_log(&format!(
            "加密服务拒绝：收到令牌长度 {}，期望长度 {expected_len}",
            received_token.len()
        ));
        return respond(&mut stream, 401, r#"{"error":"缺少或错误的令牌"}"#);
    }

    // 补齐 body 剩余部分。
    let body_start = header_end + 4;
    while raw.len() < body_start + content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
    }

    // 窗口控制**不需要请求体**：动作在 URL 里，前端发空 body 是正常的。
    // 必须在 JSON 解析之前处理——否则空 body 会被当成"非法 JSON"拒掉，
    // 表现就是标题栏那三个按钮全部点了没反应。
    if path.starts_with("/window/") {
        let action = path.trim_start_matches("/window/");
        return handle_window_action(&mut stream, action);
    }

    // 按字节截取 body（Content-Length 是字节数，不是字符数）。
    // Content-Length 缺失时退回"读到哪算哪"。
    let available = raw.len().saturating_sub(body_start);
    let want = if content_length > 0 { content_length } else { available };
    let end = body_start + want.min(available);
    let body = String::from_utf8_lossy(&raw[body_start..end]).to_string();

    let payload: serde_json::Value = match serde_json::from_str(body.trim()) {
        Ok(value) => value,
        Err(_) => return respond(&mut stream, 400, r#"{"error":"请求体不是合法 JSON"}"#),
    };

    match path {
        "/encrypt" => {
            let plain = payload.get("plain").and_then(|v| v.as_str()).unwrap_or_default();
            match crate::dpapi::encrypt(plain) {
                Ok(cipher) => {
                    let body = serde_json::json!({ "cipher": cipher }).to_string();
                    respond(&mut stream, 200, &body)
                }
                Err(error) => {
                    let body = serde_json::json!({ "error": error.to_string() }).to_string();
                    respond(&mut stream, 500, &body)
                }
            }
        }
        "/decrypt" => {
            let cipher = payload.get("cipher").and_then(|v| v.as_str()).unwrap_or_default();
            match crate::dpapi::decrypt(cipher) {
                Ok(plain) => {
                    let body = serde_json::json!({ "plain": plain }).to_string();
                    respond(&mut stream, 200, &body)
                }
                Err(error) => {
                    let body = serde_json::json!({ "error": error.to_string() }).to_string();
                    respond(&mut stream, 500, &body)
                }
            }
        }
        _ => respond(&mut stream, 404, r#"{"error":"未知接口"}"#),
    }
}

/// 处理窗口控制请求（自绘标题栏用）。
///
/// 单独一个路径前缀，和密钥接口共用端口与令牌：
/// 界面能拿到的令牌本来就只给自己用，再加一个窗口控制不会扩大攻击面。
pub fn handle_window_action(stream: &mut TcpStream, action: &str) -> std::io::Result<()> {
    match action {
        "minimize" => {
            crate::window_action("minimize");
            respond(stream, 200, r#"{"ok":true}"#)
        }
        "toggle_maximize" => {
            crate::window_action("toggle_maximize");
            respond(stream, 200, r#"{"ok":true}"#)
        }
        "close" => {
            crate::window_action("close");
            respond(stream, 200, r#"{"ok":true}"#)
        }
        _ => respond(stream, 404, r#"{"error":"未知窗口操作"}"#),
    }
}

/// 找 `\r\n\r\n` 的位置。
fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}
