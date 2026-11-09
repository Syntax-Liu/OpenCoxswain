fn main() {
    // `staging` 由 `pnpm package:daemon` 填入 daemon 资源；单独 `cargo build`
    // 时该目录可能还不存在，而 tauri-build 会校验 bundle.resources，先建空目录。
    let staging = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("staging");
    if !staging.exists() {
        let _ = std::fs::create_dir_all(&staging);
    }
    tauri_build::build()
}
