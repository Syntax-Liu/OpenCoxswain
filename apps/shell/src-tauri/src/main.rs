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

mod dpapi;
mod secret_service;

/// 密钥加密服务的端口。
///
/// 与运行时端口（47900）分开，避免和 API 混在一起被别的前端调用。
const SECRET_PORT: u16 = 47901;

/// 加密服务的共享令牌。启动时随机生成，只传给自己拉起的运行时。
struct SecretService {
    token: String,
}

/// 生成一个随机令牌。
///
/// 用 `getrandom`（已在依赖树里，走系统 CSPRNG）。
/// 不用"时间+进程号拼一拼"——那种东西看起来随机，实际可预测。
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        // 取不到系统随机数时**宁可失败也不退化成弱随机**：
        // 这个令牌是加密服务的唯一凭据。
        panic!("无法获取系统随机数，拒绝用弱随机生成密钥服务令牌");
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

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

fn runtime_command(
    node: &str,
    entry: &Path,
    static_dir: Option<&Path>,
    secret: Option<&SecretService>,
) -> Command {
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

    // 把加密服务地址与共享令牌交给运行时。
    // 只有我们自己拉起的子进程能拿到这个令牌，同机其它程序拿不到。
    if let Some(secret) = secret {
        command.env("OPENCOXSWAIN_SECRET_URL", format!("http://127.0.0.1:{SECRET_PORT}"));
        command.env("OPENCOXSWAIN_SECRET_TOKEN", &secret.token);
    }

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

fn spawn_runtime(app: &tauri::App, secret: Option<&SecretService>) -> Option<Child> {
    let entry = runtime_entry(app)?;
    let node = node_binary(app);
    let statics = static_dir(app);
    append_log(&format!(
        "runtime entry: {}（node: {}, static: {:?}）",
        entry.display(),
        node,
        statics
    ));

    match runtime_command(&node, &entry, statics.as_deref(), secret).spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            if node == "node" {
                append_log(&format!("运行时启动失败：{error}"));
                return None;
            }
            append_log(&format!("自带 Node 启动失败（{error}），回退系统 node"));
            runtime_command("node", &entry, statics.as_deref(), secret)
                .spawn()
                .ok()
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

/// 用 DPAPI 加密一段文本，返回 base64。
///
/// 只有窄接口：**只用来加密/解密密钥**，不提供通用加解密服务。
#[tauri::command]
fn encrypt_secret(plain: String) -> Result<String, String> {
    dpapi::encrypt(&plain).map_err(|error| error.to_string())
}

/// 用 DPAPI 解密 base64 密文。
#[tauri::command]
fn decrypt_secret(cipher: String) -> Result<String, String> {
    dpapi::decrypt(&cipher).map_err(|error| error.to_string())
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

/// 构建托盘图标与菜单。
///
/// 这里同时接管窗口的关闭行为：**点关闭只隐藏窗口**，
/// 因为执行者可能还在跑——直接把进程杀掉会让用户丢掉正在进行的任务。
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出（会停止正在跑的执行者）", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("OpenCoxswain 舵手")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                // 真正退出：先关窗口触发 RunEvent::Exit，那里的逻辑会结束运行时。
                append_log("用户从托盘选择退出");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击图标 → 唤回窗口（Windows 上的常见习惯）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 用应用图标；取不到就退化成无图标托盘（不影响功能）。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// 把主窗口显示出来并聚焦。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    // 崩溃也要留下痕迹：桌面应用没有终端，否则用户只看到窗口消失。
    install_panic_hook();

    let app = match tauri::Builder::default()
        // 单实例必须**第一个**注册（插件文档要求）：
        // 它要在其它插件和窗口初始化之前就拦下第二个进程。
        //
        // 第二个进程进来时不会起新窗口，而是把已有窗口拉到前台——
        // 之前双击两次会起两个进程，抢同一个端口和同一个 SQLite 库：
        // 轻则第二个窗口白屏，重则两个进程同时写库。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            append_log("检测到已有实例，唤回原窗口");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // 自动更新：检查与下载由插件完成，安装后由 process 插件重启。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 更新相关的三个命令由界面通过运行时转发调用（界面跑在 http 端口上，
        // 拿不到 Tauri IPC，所以必须由壳暴露成 HTTP 能触达的命令）。
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            current_version,
            encrypt_secret,
            decrypt_secret
        ])
        .manage(Runtime(Mutex::new(None)))
        .setup(|app| {
            // 密钥加密服务：先起它，再拉起运行时（运行时启动时要拿到共享令牌）。
            let secret = SecretService {
                token: random_token(),
            };
            secret_service::set_token(secret.token.clone());
            secret_service::serve(SECRET_PORT);
            append_log(&format!("密钥加密服务已启动（端口 {SECRET_PORT}）"));

            let child = spawn_runtime(app, Some(&secret));
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

            // ---- 托盘 ----
            // **关窗口不等于退出**：执行者可能还在跑，直接退出会把它们全部杀掉。
            // 所以点关闭只隐藏窗口，真正退出走托盘菜单。
            build_tray(app)?;

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

    app.run(|app, event| match event {
        // 点窗口关闭：**隐藏而不是退出**。
        // 执行者可能正在跑，关掉进程会让用户丢掉任务。
        // 真正退出走托盘菜单里的"退出"。
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if label == "main" {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                append_log("窗口已隐藏到托盘（执行者继续运行；从托盘菜单可退出）");
            }
        }
        tauri::RunEvent::Exit => {
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
        _ => {}
    });
}
