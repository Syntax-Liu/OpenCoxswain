/**
 * 关闭行为设置：点窗口关闭时，是退出软件还是最小化到托盘。
 *
 * ## 两种模式
 *
 * - `tray`：隐藏窗口，Agent 继续跑（旧行为）
 * - `quit`：直接退出
 *
 * ## 一条安全规则
 *
 * 选 `quit` 时，**如果有 Agent 正在跑，必须先提示用户**。
 * 否则用户以为只是关个窗口，实际把正在改代码的 Agent 全杀了。
 * 这条规则由 `shouldConfirmQuit` 表达，壳和界面都用它。
 */

export type CloseAction = 'tray' | 'quit';

export interface CloseSettings {
  readonly closeAction: CloseAction;
}

export const DEFAULT_CLOSE_SETTINGS: CloseSettings = { closeAction: 'tray' };

/** 关闭前是否需要提醒用户（有 Agent 在跑时才需要）。 */
export function shouldConfirmQuit(
  action: CloseAction,
  runningAgents: number,
): { readonly confirm: boolean; readonly message: string } {
  if (action === 'tray') return { confirm: false, message: '' };
  if (runningAgents <= 0) return { confirm: false, message: '' };
  return {
    confirm: true,
    message: `还有 ${runningAgents} 个 Agent 正在运行。现在关闭会中断它们，未完成的工作会丢掉。`,
  };
}

/** 设置文件的读写（和 schedules 一样用 JSON：量小、用户可能想直接改）。 */
export interface CloseSettingsStoreLike {
  load(): Promise<CloseSettings>;
  save(settings: CloseSettings): Promise<void>;
}

export class MemoryCloseSettings implements CloseSettingsStoreLike {
  private current: CloseSettings = DEFAULT_CLOSE_SETTINGS;

  async load(): Promise<CloseSettings> {
    return this.current;
  }

  async save(settings: CloseSettings): Promise<void> {
    this.current = settings;
  }
}

/** 从磁盘读写的实现。 */
export class CloseSettingsStore implements CloseSettingsStoreLike {
  constructor(private readonly file: string) {}

  async load(): Promise<CloseSettings> {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<CloseSettings>;
      const action = raw.closeAction === 'quit' ? 'quit' : 'tray';
      return { closeAction: action };
    } catch {
      return DEFAULT_CLOSE_SETTINGS;
    }
  }

  async save(settings: CloseSettings): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}
