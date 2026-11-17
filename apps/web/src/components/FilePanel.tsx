/**
 * 右栏「文件」页签：项目文件列表 + 内容预览。
 *
 * ## 数据形态
 *
 * 后端 `/files` 返回的是**扁平列表**（path / name / size），
 * 不是嵌套树。这里按 `/` 前缀就地分组——比让后端造树简单，
 * 而且不需要额外的接口。
 *
 * ## 为什么按需加载
 *
 * 项目可能有几千个文件。进页签只列**根层**，
 * 点开目录才请求它下面的（后端支持 `?q=` 前缀过滤）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ApiClient, FileEntryDto } from '../api.js';
import { ListItem, TextButton } from '../ui/index.js';

export interface FilePanelProps {
  readonly api: ApiClient;
  readonly projectId: string;
}

/** 一层目录下的条目。 */
interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly size: number;
}

/** 把一个扁平路径列表收成"当前层"的条目。 */
export function childrenOf(files: readonly FileEntryDto[], prefix: string): TreeNode[] {
  const out = new Map<string, TreeNode>();
  for (const f of files) {
    if (prefix && !f.path.startsWith(prefix + '/')) continue;
    const rest = prefix ? f.path.slice(prefix.length + 1) : f.path;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      out.set(f.path, { name: rest, path: f.path, isDir: false, size: f.size });
    } else {
      const dirPath = prefix ? `${prefix}/${rest.slice(0, slash)}` : rest.slice(0, slash);
      if (!out.has(dirPath)) {
        out.set(dirPath, { name: rest.slice(0, slash), path: dirPath, isDir: true, size: 0 });
      }
    }
  }
  // 目录在前，然后按名字排
  return [...out.values()].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilePanel(props: FilePanelProps): JSX.Element {
  const [all, setAll] = useState<readonly FileEntryDto[]>([]);
  const [openDirs, setOpenDirs] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    props.api
      .listFiles(props.projectId, '')
      .then((r) => {
        if (!alive) return;
        setAll(r.files);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : '读取文件列表失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [props.api, props.projectId]);

  const openFile = useCallback(
    async (path: string) => {
      setPreviewPath(path);
      setPreview(null);
      setPreviewError(null);
      try {
        const r = await props.api.readFile(props.projectId, path);
        setPreview(r.content);
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : '读取失败');
      }
    },
    [props.api, props.projectId],
  );

  const root = useMemo(() => childrenOf(all, ''), [all]);

  if (loading) return <p className="rail-empty-text">读取中…</p>;
  if (error) return <p className="rail-empty-text">{error}</p>;
  if (root.length === 0) return <p className="rail-empty-text">这个项目还没有文件。</p>;

  /** 递归渲染一层。 */
  const renderLevel = (nodes: readonly TreeNode[], depth: number): JSX.Element => (
    <ul className="file-tree" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {nodes.map((n) => {
        const open = openDirs.includes(n.path);
        return (
          <li key={n.path}>
            <ListItem onClick={() => {
                if (n.isDir) {
                  setOpenDirs((prev) =>
                    prev.includes(n.path) ? prev.filter((p) => p !== n.path) : [...prev, n.path],
                  );
                } else {
                  void openFile(n.path);
                }
              }} title={n.path} variant={"file-node"}><span className="file-node-name">{n.isDir ? (open ? '▾ ' : '▸ ') + n.name : n.name}</span>{!n.isDir && <span className="file-node-size">{formatSize(n.size)}</span>}</ListItem>
            {n.isDir && open && renderLevel(childrenOf(all, n.path), depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="file-panel">
      {renderLevel(root, 0)}

      {previewPath && (
        <div className="file-preview">
          <div className="file-preview-head">
            <span className="diff-path">{previewPath}</span>
            <TextButton onClick={() => setPreviewPath(null)}>收起
            </TextButton>
          </div>
          {previewError ? (
            <p className="rail-empty-text">{previewError}</p>
          ) : preview === null ? (
            <p className="rail-empty-text">读取中…</p>
          ) : (
            <pre className="file-preview-body">{preview}</pre>
          )}
        </div>
      )}
    </div>
  );
}
