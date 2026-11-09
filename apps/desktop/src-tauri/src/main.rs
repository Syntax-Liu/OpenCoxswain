#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 47821;

/// 由 Rust 持有的 daemon 子进程；退出时一并结束，避免孤儿进程。
struct Daemon(Mutex<Option<Child>>);

/// Tauri 的 `resource_dir()` 在 Windows 上返回 `\\?\` 前缀的 verbatim 路径，
/// Node 的 CJS 加载器无法正确处理，统一去掉前缀再交给子进程。
fn normalize(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn daemon_entry(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(entry) = std::env::var("OPENCOXSWAIN_DAEMON_ENTRY") {
        let path = PathBuf::from(entry);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource
            .join("staging")
            .join("daemon")
            .join("dist")
            .join("index.js");
        if bundled.exists() {
            return Some(normalize(bundled));
        }
    }
    // 开发态：直接使用工作区里已构建的 daemon。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("daemon")
        .join("dist")
        .join("index.js");
    if dev.exists() {
        return Some(dev);
    }
    None
}

fn log_file() -> Option<File> {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("OpenCoxswain").join("logs");
    fs::create_dir_all(&dir).ok()?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("daemon.log"))
        .ok()
}

fn append_log(line: &str) {
    if let Some(mut file) = log_file() {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

fn spawn_daemon(app: &tauri::App) -> Option<Child> {
    let entry = daemon_entry(app)?;
    append_log(&format!("daemon entry: {}", entry.display()));
    let mut command = Command::new("node");
    command
        .arg(&entry)
        .env("OPENCOXSWAIN_PORT", PORT.to_string());
    match log_file() {
        Some(file) => {
            let clone = file.try_clone();
            command.stdout(Stdio::from(file));
            command.stderr(clone.map(Stdio::from).unwrap_or_else(|_| Stdio::null()));
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().ok()
}

fn wait_for_daemon() {
    let address: SocketAddr = ([127, 0, 0, 1], PORT).into();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Daemon(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_daemon(app);
            if let Some(child) = child {
                if let Ok(mut slot) = app.state::<Daemon>().0.lock() {
                    *slot = Some(child);
                }
            }
            wait_for_daemon();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("OpenCoxswain · 舵手")
                .inner_size(1280.0, 860.0)
                .min_inner_size(1024.0, 720.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build OpenCoxswain")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut slot) = app.state::<Daemon>().0.lock() {
                    if let Some(mut child) = slot.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
