#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

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

/// `panic = "abort"` 下 panic 会直接 fail-fast（0xc0000409），窗口模式下连控制台都没有，
/// 用户只看到「点了没反应」。这里先把原因落盘，再交给 abort。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|spot| format!("{}:{}", spot.file(), spot.line()))
            .unwrap_or_else(|| "未知位置".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知错误".to_string());
        append_log(&format!("panic {location}：{payload}"));
    }));
}

/// 优先使用安装包自带的 Node 运行时，其次才回退到系统 PATH 里的 node。
fn node_binary(app: &tauri::App) -> String {
    if let Ok(exe) = std::env::var("OPENCOXSWAIN_NODE_BIN") {
        if PathBuf::from(&exe).exists() {
            return exe;
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = normalize(
            resource
                .join("staging")
                .join("runtime")
                .join("node.exe"),
        );
        if bundled.exists() {
            return bundled.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

fn daemon_command(node: &str, entry: &Path) -> Command {
    let mut command = Command::new(node);
    command
        .arg(entry)
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
    command
}

fn spawn_daemon(app: &tauri::App) -> Option<Child> {
    let entry = daemon_entry(app)?;
    let node = node_binary(app);
    append_log(&format!(
        "daemon entry: {}（node: {}）",
        entry.display(),
        node
    ));
    match daemon_command(&node, &entry).spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            if node == "node" {
                append_log(&format!("daemon 启动失败：{error}"));
                return None;
            }
            append_log(&format!("自带 Node 运行时启动失败（{error}），回退到系统 node"));
            daemon_command("node", &entry).spawn().ok()
        }
    }
}

/// 后台确认 daemon 是否就绪。界面不依赖它：daemon 起不来也要先把窗口给用户。
fn wait_for_daemon() {
    let address: SocketAddr = ([127, 0, 0, 1], PORT).into();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok() {
            append_log("daemon 已就绪");
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    append_log("daemon 20 秒内未就绪：窗口已显示，界面会提示重试");
}

/// 更新源配置。发布地址与公钥因部署环境而异，且私钥绝不能进仓库，
/// 所以放在用户数据目录，而不是写死进 tauri.conf.json。
#[derive(serde::Deserialize, Default)]
struct UpdaterConfig {
    endpoint: Option<String>,
    pubkey: Option<String>,
}

fn updater_config_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("OpenCoxswain").join("updater.json")
}

fn updater_config() -> UpdaterConfig {
    let mut config = UpdaterConfig::default();
    match fs::read_to_string(updater_config_path()) {
        Ok(text) => match serde_json::from_str::<UpdaterConfig>(&text) {
            Ok(parsed) => config = parsed,
            Err(error) => append_log(&format!("updater.json 解析失败：{error}")),
        },
        Err(_) => {}
    }
    if let Ok(value) = std::env::var("OPENCOXSWAIN_UPDATER_ENDPOINT") {
        config.endpoint = Some(value);
    }
    if let Ok(value) = std::env::var("OPENCOXSWAIN_UPDATER_PUBKEY") {
        config.pubkey = Some(value);
    }
    UpdaterConfig {
        endpoint: config.endpoint.map(|value| value.trim().to_string()),
        pubkey: config.pubkey.map(|value| value.trim().to_string()),
    }
}

fn build_updater(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Updater>, String> {
    let config = updater_config();
    let endpoint = config.endpoint.unwrap_or_default();
    let pubkey = config.pubkey.unwrap_or_default();
    if endpoint.is_empty() || pubkey.is_empty() {
        return Ok(None);
    }
    let url: url::Url = endpoint
        .parse()
        .map_err(|error| format!("更新地址无效：{error}"))?;
    let updater = app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![url])
        .map_err(|error| format!("更新源不可用：{error}"))?
        .build()
        .map_err(|error| format!("初始化更新器失败：{error}"))?;
    Ok(Some(updater))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    configured: bool,
    current_version: String,
    latest_version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> UpdateStatus {
    let mut status = UpdateStatus {
        configured: false,
        current_version: app_version(app.clone()),
        latest_version: None,
        notes: None,
        date: None,
        error: None,
    };
    let updater = match build_updater(&app) {
        Ok(Some(updater)) => updater,
        Ok(None) => return status,
        Err(error) => {
            status.error = Some(error);
            return status;
        }
    };
    status.configured = true;
    match updater.check().await {
        Ok(Some(update)) => {
            status.latest_version = Some(update.version.clone());
            status.notes = update.body.clone();
            status.date = update.date.map(|value| value.to_string());
        }
        Ok(None) => {}
        Err(error) => status.error = Some(format!("检查更新失败：{error}")),
    }
    status
}

#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<String, String> {
    let updater = build_updater(&app)?.ok_or_else(|| "未配置更新源".to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
        .ok_or_else(|| "已经是最新版本".to_string())?;
    let version = update.version.clone();
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| format!("下载或安装失败：{error}"))?;
    append_log(&format!("已安装 {version}，准备重启"));
    app.restart();
    #[allow(unreachable_code)]
    Ok(version)
}

fn main() {
    install_panic_hook();
    let app = match tauri::Builder::default()
        .manage(Daemon(Mutex::new(None)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_version,
            update_check,
            update_install
        ])
        .setup(|app| {
            let child = spawn_daemon(app);
            if let Some(child) = child {
                if let Ok(mut slot) = app.state::<Daemon>().0.lock() {
                    *slot = Some(child);
                }
            }
            // 先建窗口再等 daemon：daemon 慢或起不来时，用户看到的应该是界面里的提示，
            // 而不是双击图标后一段时间毫无反应。
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("OpenCoxswain 舵手")
                .inner_size(1280.0, 860.0)
                .min_inner_size(1024.0, 720.0)
                .build()
                .map_err(|error| {
                    append_log(&format!("窗口创建失败：{error}"));
                    error
                })?;
            std::thread::spawn(wait_for_daemon);
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            append_log(&format!("应用启动失败：{error}"));
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut slot) = app.state::<Daemon>().0.lock() {
                if let Some(mut child) = slot.take() {
                    // Windows 上 child.kill() 只结束 daemon 本身，它拉起的 OpenCode
                    // 与验收命令会变成孤儿进程；这里按进程树强杀。
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let pid = child.id().to_string();
                        let _ = Command::new("taskkill")
                            .args(["/pid", &pid, "/T", "/F"])
                            .creation_flags(0x0800_0000)
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
