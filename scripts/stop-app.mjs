/**
 * 优雅关闭 OpenCoxswain（给构建/安装脚本用）。
 *
 * ## 为什么不能 `Stop-Process -Force`
 *
 * `Stop-Process -Force` 走的是 `TerminateProcess` —— **进程直接消失，
 * 不给任何回调**。于是：
 *
 *   1. Tauri 的 `RunEvent::Exit` 不执行
 *   2. 托盘图标不会调用 `NIM_DELETE` 注销
 *   3. Windows 认为它还活着，托盘里留一个**僵尸槽位**
 *   4. 鼠标划过才被回收 —— 用户看到的"一移到上面就消失"
 *
 * ## 正确做法
 *
 * 向主窗口发 `WM_CLOSE`。Tauri 会走正常的关窗路径
 * （要么隐藏到托盘、要么退出），最终走 `RunEvent::Exit` 里的
 * `remove_tray_by_id` + 运行时清理。
 *
 * 只有当优雅关闭超时（卡住）才退回强杀——但会**明确打印警告**，
 * 因为强杀会留僵尸图标。
 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PROCESS_NAME = 'opencoxswain';
const GRACEFUL_TIMEOUT_MS = 15_000;

const ps = (cmd) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
};

const alive = () =>
  Number(ps(`(Get-Process ${PROCESS_NAME} -ErrorAction SilentlyContinue | Measure-Object).Count`)) > 0;

export async function stopGracefully({ quiet = false } = {}) {
  if (!alive()) {
    if (!quiet) console.log('应用未运行');
    return true;
  }

  // 1. 向**真正的 Tauri 窗口**发 WM_CLOSE。
  //
  // 不能用 `$_.CloseMainWindow()`：PowerShell 的 `MainWindowHandle`
  // 在这个应用上指向的是一个内部隐藏窗口（标题是
  // `com.opencoxswain.desktop-siw`），不是我们的界面窗口
  // （标题 `OpenCoxswain 舵手`）。发给错的窗口，Tauri 收不到
  // 关窗事件，就永远走不到 RunEvent::Exit。
  //
  // 这里按窗口类 `Tauri Window` + 进程 id 精确找。
  ps(`
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OcWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static int CloseAll(uint target) {
    int sent = 0;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var cn = new StringBuilder(128); GetClassNameW(h, cn, 128);
        if (cn.ToString() == "Tauri Window") { PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); sent++; }
      }
      return true;
    }, IntPtr.Zero);
    return sent;
  }
}
'@ -ErrorAction SilentlyContinue
    $proc = Get-Process ${PROCESS_NAME} -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
      $n = [OcWin]::CloseAll([uint32]$proc.Id)
      Write-Output "已向 $n 个 Tauri 窗口发送 WM_CLOSE"
    }
  `);

  for (let i = 0; i < GRACEFUL_TIMEOUT_MS / 300; i += 1) {
    await sleep(300);
    if (!alive()) {
      if (!quiet) console.log('✓ 应用已优雅退出');
      // 再等一下让 node 子进程也退
      await sleep(800);
      return true;
    }
  }

  // 2. 超时了。可能是"关闭 = 隐藏到托盘"的设置，或界面卡住。
  console.warn(
    '⚠ 优雅关闭超时，退回强杀。\n' +
      '  强杀会跳过托盘注销，**可能留下一个幽灵图标**（鼠标划过才消失）。\n' +
      '  如果你看到了，那是这一步造成的。',
  );
  ps(`Get-Process ${PROCESS_NAME} -ErrorAction SilentlyContinue | Stop-Process -Force -EA SilentlyContinue`);
  await sleep(1500);
  return false;
}

/** 顺手清掉孤儿 node 运行时（不碰其它 node）。 */
export function killOrphanRuntime() {
  ps(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*staging*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }`,
  );
}

// 允许直接运行：node scripts/stop-app.mjs
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ok = await stopGracefully({ quiet: false });
  killOrphanRuntime();
  process.exitCode = ok ? 0 : 1;
}
