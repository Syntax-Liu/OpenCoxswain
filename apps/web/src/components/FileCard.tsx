/**
 * 文件变更卡片。
 *
 * 用户原话：「方案的呈现只需要像截图这样，提示创建或修改了哪个文件，
 * 不需要做这么复杂的功能。我们想做的就是让用户和 AI 更轻松地对话，
 * 而不是造一堆窗口。」
 *
 * 所以这里**不造窗口**：就是在对话流里一张轻量卡片——
 *   图标 + 文件名 + 「创建 / 修改 / 删除」+ 预览按钮
 * 点预览才在侧边栏打开内容。
 *
 * 数据来自副作用台账（`fs.write` / `fs.delete`），那是系统真记账的事实，
 * 不是 Assistant 的自述。
 */
import type { SideEffectDto } from '../api.js';

export interface FileCardProps {
  readonly effect: SideEffectDto;
  readonly onPreview: (path: string) => void;
}

/** 从完整路径里取文件名与所在目录。 */
export function splitPath(target: string): { name: string; dir: string } {
  const norm = target.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return { name: norm, dir: '' };
  return { name: norm.slice(idx + 1), dir: norm.slice(0, idx) };
}

/** 该动作用哪个动词。 */
export function actionVerb(effect: SideEffectDto): string {
  if (effect.kind === 'fs.delete') return '删除';
  // fs.write 区分新建与修改看 note —— 没有就笼统说「修改」
  if (effect.note && /creat|new|新建/i.test(effect.note)) return '创建';
  return '修改';
}

/** 按扩展名给一个类型标签（截图里是 "MB" 那种小方块）。 */
export function fileBadge(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'FILE';
  const ext = name.slice(dot + 1).toUpperCase();
  if (ext === 'TSX' || ext === 'TS') return ext === 'TSX' ? 'TSX' : 'TS';
  if (ext === 'MD') return 'MD';
  if (ext === 'JSON') return 'JSON';
  return ext.slice(0, 4);
}

/**
 * 从 `target` 里取出真实文件路径。
 *
 * 实测：`fs.delete` 的 target 存的是**整条命令**，不是路径——
 *   例：`del /q "D:\...\e2e-approval-test.txt" & echo EXITCODE=%ERRORLEVEL%`
 *   例：`cmd /c "rmdir /s /q apps\web\dist-test\build-probe"`
 * 直接显示会变成 "FILEbuild-probe\" 这种乱码。
 *
 * 这里做保守提取：优先取带引号且看起来像路径的片段，
 * 否则退回去掉常见命令前缀。取不到就返回 null，让调用方跳过这张卡。
 */
export function extractPath(target: string, kind: string): string | null {
  const t = target.trim();

  // fs.write 直接是路径
  if (kind === 'fs.write') return t.includes('\\') || t.includes('/') || /\.[a-z0-9]+$/i.test(t) ? t : null;

  // fs.delete：可能是命令行
  // 1) 引号里的路径（优先，最可靠）
  //    但引号里可能是整条命令，所以要排除含 && || 或以命令词开头的片段
  const quoted = [...t.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter(
      (s) =>
        /[\\/]|\.[a-z0-9]{1,8}$/i.test(s) &&
        !/^cmd$/i.test(s) &&
        !/[&|>]/.test(s) &&
        !/^(cd|cmd|powershell|node|npx|pnpm|git|del|rmdir|rm)\b/i.test(s),
    );
  if (quoted.length > 0) return quoted[quoted.length - 1]!;

  // 2) 去掉常见删除命令前缀后的剩余部分
  const stripped = t
    .replace(/^(cmd\s*\/c\s+"?)/i, '')
    // 命令词 + 任意个开关（/q /s /f /r 都是单字母，也支持连写）
    .replace(/^(del|erase|rmdir|rd|rm|remove)(\s+\/[a-z]+)*\s*/i, '')
    .replace(/"\s*&\s*echo.*$/i, '')
    .replace(/"\s*$/i, '')
    .trim();

  if (!stripped) return null;
  // 还是像命令行（有 | & > 或含命令词）就不要了
  if (/[|&>]/.test(stripped)) return null;
  if (/^(cmd|powershell|node|npx|pnpm|git|cd|vite)\b/i.test(stripped)) return null;
  // 带参数的样子（"xxx /s /q"）说明没抠干净
  if (/\/[a-z]\b/i.test(stripped)) return null;
  return stripped;
}

export function FileCard(props: FileCardProps): JSX.Element | null {
  const { effect } = props;
  // 只显示文件类副作用；跑命令、外发等不在这里
  if (effect.kind !== 'fs.write' && effect.kind !== 'fs.delete') return null;
  // 被拒绝或已撤销的不该显示成"改了"
  if (effect.state === 'rejected' || effect.state === 'undone') return null;

  const path = extractPath(effect.target, effect.kind);
  // 提取不到真实路径就不显示——宁可少一张卡，也不要给用户看乱码
  if (!path) return null;

  const { name, dir } = splitPath(path);
  const verb = actionVerb(effect);
  const canPreview = effect.kind === 'fs.write' && effect.state === 'succeeded';

  return (
    <div className={`file-card ${effect.kind === 'fs.delete' ? 'deleted' : 'written'}`}>
      <span className="file-card-badge" aria-hidden>
        {fileBadge(name)}
      </span>

      <span className="file-card-main">
        <span className="file-card-name">{name}</span>
        <span className="file-card-meta">
          {verb}
          {dir && <span className="file-card-dir">{dir}</span>}
        </span>
      </span>

      {canPreview && (
        <button
          type="button"
          className="btn btn--secondary btn--sm file-card-preview"
          onClick={() => props.onPreview(path)}
          title="在侧边栏预览"
        >
          预览
        </button>
      )}
    </div>
  );
}
