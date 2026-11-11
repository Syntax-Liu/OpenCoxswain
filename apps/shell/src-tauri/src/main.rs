// 防止 Windows 下额外弹出控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! OpenCoxswain 桌面壳。
//!
//! 职责只有一件事：**拉起自研运行时，然后加载它的界面**。
//!
//! ```
//! 双击图标
//!   └─ 壳启动 Node（优先用安装包自带的运行时）
//!        └─ node runtime/dist/cli.js --serve --port 47900 --static <界面目录>
//!             └─ 同一端口既服务 /api/*(REST+SSE) 又服务工作台静态文件
//!   └─ 壳开窗口，加载 http://127.0.0.1:47900/
//! ```
//!
//! 为什么让运行时同时服务界面：
//! - 界面与 API **同源**，没有 CORS、没有额外端口；
//! - 退出时只需结束一个子进程树。
//!
//! 沿用 legacy 桌面壳里已经踩过坑的做法：
//! - 优先用安装包自带的 Node 运行时，找不到才回退系统 node；
//! - 先把窗口给用户，再在后台等运行时就绪（daemon 慢不该表现为"双击没反应"）；
//! - 退出时按**进程树**强杀，否则运行时拉起的子进程会变成孤儿。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 运行时监听端口。与 `apps/runtime` 的默认值保持一致。
const PORT: u16 = 47900;

struct Runtime(Mutex<Option<Child>>);

fn normalize(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().replace('/', "\\");
    // 剥掉 Windows 的 verbatim 前缀 `\\?\`（以及 `\\?\UNC\`）。
    //
    // Tauri 的 resource_dir() 在部分环境下返回 verbatim 路径，如
    // `\\?\D:\...\staging\runtime\cli.js`。Node 的模块解析无法处理这个前缀，
    // 会把 `D:` 当成一个目录去 lstat，报 `EISDIR: lstat 'D:'`。
    let stripped = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        // UNC 路径：\\?\UNC\server\share → \\server\share
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.clone()
    };
    PathBuf::from(stripped)
}

/// 运行时入口：开发者用 `OPENCOXSWAIN_RUNTIME_ENTRY` 覆盖，安装包里取 staging。
fn runtime_entry(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(value) = std::env::var("OPENCOXSWAIN_RUNTIME_ENTRY") {
        let path = PathBuf::from(&value);
        if path.exists() {
            return Some(path);
        }
        append_log(&format!("OPENCOXSWAIN_RUNTIME_ENTRY 指向的文件不存在：{value}"));
    }

    if let Ok(resource) = app.path().resource_dir() {
        let staged = normalize(resource.join("staging").join("runtime").join("cli.js"));
        if staged.exists() {
            return Some(staged);
        }
        append_log(&format!("安装资源里没有运行时入口：{}", staged.display()));
    }

    // 开发态：回退到源码树里的构建产物。
    let dev = normalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../runtime/dist/cli.js"));
    if dev.exists() {
        return Some(dev);
    }
    append_log("找不到运行时入口，界面将显示连接失败提示");
    None
}

/// 工作台静态文件目录（web 构建产物）。
fn static_dir(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(resource) = app.path().resource_dir() {
        let staged = normalize(resource.join("staging").join("web"));
        if staged.join("index.html").exists() {
            return Some(staged);
        }
    }
    let dev = normalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"));
    if dev.join("index.html").exists() {
        return Some(dev);
    }
    None
}

fn log_path() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("OpenCoxswain").join("logs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("runtime.log"))
}

fn log_file() -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path()?)
        .ok()
}

fn append_log(line: &str) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(mut file) = log_file() {
        let _ = writeln!(file, "[{stamp}] {line}");
    }
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        append_log(&format!("panic {location}：{info}"));
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
        let bundled = normalize(resource.join("staging").join("node").join("node.exe"));
        if bundled.exists() {
            return bundled.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

fn runtime_command(node: &str, entry: &Path, static_dir: Option<&Path>) -> Command {
    let mut command = Command::new(node);
    command
        .arg(entry)
        // 桌面壳模式：只起服务，不进入交互循环。
        // **不要传 --project** —— 项目由界面里的"打开项目"决定。
        // （早期版本传了 current_dir()，在 D:\ 下会被 Node 解析成 "D:" 导致 EISDIR。）
        .arg("--serve")
        .arg("--port")
        .arg(PORT.to_string());
    if let Some(dir) = static_dir {
        command.arg("--static").arg(dir);
    }
    command.env("OPENCOXSWAIN_PORT", PORT.to_string());

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
        // CREATE_NO_WINDOW：不要弹出控制台
        command.creation_flags(0x0800_0000);
    }
    command
}

fn spawn_runtime(app: &tauri::App) -> Option<Child> {
    let entry = runtime_entry(app)?;
    let node = node_binary(app);
    let statics = static_dir(app);
    append_log(&format!(
        "runtime entry: {}（node: {}, static: {:?}）",
        entry.display(),
        node,
        statics
    ));

    match runtime_command(&node, &entry, statics.as_deref()).spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            if node == "node" {
                append_log(&format!("运行时启动失败：{error}"));
                return None;
            }
            append_log(&format!("自带 Node 启动失败（{error}），回退系统 node"));
            runtime_command("node", &entry, statics.as_deref()).spawn().ok()
        }
    }
}

/// 后台确认运行时是否就绪。界面不依赖它：起不来也要先把窗口给用户。
fn wait_for_runtime() {
    let address: SocketAddr = ([127, 0, 0, 1], PORT).into();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok() {
            append_log("运行时已就绪");
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    append_log("运行时 30 秒内未就绪：窗口已显示，界面会提示重试");
}

/// 当前版本号（界面用来和远端比较，也用于展示）。
#[tauri::command]
fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 更新检查结果写到这个文件，运行时读出来给界面用。
///
/// 为什么要绕这一圈：界面是通过 `http://127.0.0.1:PORT` 加载的，
/// **不是 Tauri 本地协议**，所以它拿不到 IPC、调不到 command。
/// 与其为了自动更新去改整个窗口加载方式（风险大），
/// 不如让壳把结果落成一个文件，运行时通过已有的 HTTP 接口透出去。
fn update_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("update-check.json"))
}

/// 检查更新。**离线或出错时返回 None，不打扰用户**。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: String,
    current_version: String,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let code = check_update_inner(&app).await;
    // 结果同时落盘：界面拿不到 IPC，只能通过运行时读文件。
    if let (Some(path), Ok(info)) = (update_file(&app), &code) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let body = match info {
            Some(update) => serde_json::json!({
                "available": true,
                "version": update.version,
                "notes": update.notes,
                "currentVersion": update.current_version,
                "checkedAt": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
            }),
            None => serde_json::json!({
                "available": false,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "checkedAt": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
            }),
        };
        let _ = std::fs::write(path, body.to_string());
    }
    code
}

async fn check_update_inner(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|error| error.to_string())?;
    // 断网/接口异常时安静返回 None：更新检查失败不该影响正常使用。
    let found = match updater.check().await {
        Ok(found) => found,
        Err(_) => return Ok(None),
    };

    Ok(found.map(|update| UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        current_version: update.current_version.clone(),
    }))
}
/// 下载并安装更新，成功后重启。
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|error| error.to_string())?;
    let found = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "没有可用更新".to_string())?;

    // 下载 + 安装。签名由插件用配置里的 pubkey 校验，对不上会直接失败。
    found
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| format!("下载或校验失败：{error}"))?;

    app.restart();
}

fn main() {
    // 崩溃也要留下痕迹：桌面应用没有终端，否则用户只看到窗口消失。
    install_panic_hook();

    let app = match tauri::Builder::default()
        // 自动更新：检查与下载由插件完成，安装后由 process 插件重启。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 更新相关的三个命令由界面通过运行时转发调用（界面跑在 http 端口上，
        // 拿不到 Tauri IPC，所以必须由壳暴露成 HTTP 能触达的命令）。
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            current_version
        ])
        .manage(Runtime(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_runtime(app);
            if let Some(child) = child {
                if let Ok(mut slot) = app.state::<Runtime>().0.lock() {
                    *slot = Some(child);
                }
            }

            // 先建窗口再等运行时：运行时慢或起不来时，
            // 用户看到的应该是界面里的提示，而不是双击图标后毫无反应。
            //
            // URL 带上版本号：升级后 webview 一定会重新拉取界面资源，
            // 而不是沿用上一次的缓存页面（曾经因此看到过"修了却没生效"）。
            let url = format!("http://127.0.0.1:{PORT}/?v={}", env!("CARGO_PKG_VERSION"));
            let parsed: tauri::Url = url
                .parse()
                .map_err(|error| format!("界面地址无效（{url}）：{error}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("OpenCoxswain 舵手")
                .inner_size(1320.0, 880.0)
                .min_inner_size(1024.0, 720.0)
                .build()
                .map_err(|error| {
                    append_log(&format!("窗口创建失败：{error}"));
                    error
                })?;

            std::thread::spawn(wait_for_runtime);
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
            if let Ok(mut slot) = app.state::<Runtime>().0.lock() {
                if let Some(mut child) = slot.take() {
                    // Windows 上 child.kill() 只结束运行时本身，
                    // 它拉起的进程会变成孤儿；这里按进程树强杀。
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
                    append_log("运行时已结束");
                }
            }
        }
    });
}
