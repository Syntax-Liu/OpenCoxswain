import { useCallback, useRef, useState } from 'react';

/**
 * 附件处理：拖入 / 粘贴 / 选择文件。
 *
 * ## 三类文件三种处理
 *
 * | 类型 | 处理 | 为什么 |
 * | --- | --- | --- |
 * | 图片 | 转 data URL，走多模态通道 | 截图报错是最常见的需求 |
 * | 文本/代码 | 读内容注入上下文 | 比让它自己找文件更快、更明确 |
 * | 其它二进制 | 只带文件名和大小 | 读不出内容，但至少让它知道有这个文件 |
 *
 * ## 一条硬约束：大小上限
 *
 * 不做上限的话，一张 20MB 的图会让整个请求超时。
 * 超限时**明确告诉用户**，不静默丢弃。
 */

/** 单个附件。 */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind: 'image' | 'text' | 'binary';
  /** 图片的 data URL；文本为 null。 */
  readonly dataUrl: string | null;
  /** 文本内容（截断后）；图片与二进制为 null。 */
  readonly text: string | null;
  readonly bytes: number;
  /** 超限等问题的说明。 */
  readonly warning?: string;
}

/** 单文件上限：图片 5MB，文本 200KB（超了截断）。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt',
  'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'ps1', 'bat',
  'css', 'scss', 'less', 'html', 'xml', 'sql', 'vue', 'svelte', 'gitignore',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function classifyFile(name: string, type: string): Attachment['kind'] {
  if (type.startsWith('image/') || IMAGE_EXT.has(extOf(name))) return 'image';
  if (type.startsWith('text/') || TEXT_EXT.has(extOf(name)) || !extOf(name)) return 'text';
  return 'binary';
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `att_${Date.now().toString(36)}_${counter}`;
}

/**
 * 把一个 File 转成附件。
 *
 * **失败不抛错**，而是返回一个带 warning 的附件——用户至少能看到
 * "这个文件没读进来"以及原因，而不是拖进去什么都没发生。
 */
export async function toAttachment(file: File): Promise<Attachment> {
  const kind = classifyFile(file.name, file.type);
  const base = { id: nextId(), name: file.name, kind, bytes: file.size };

  if (kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) {
      return {
        ...base,
        dataUrl: null,
        text: null,
        warning: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，已跳过`,
      };
    }
    try {
      return { ...base, dataUrl: await readAsDataUrl(file), text: null };
    } catch {
      return { ...base, dataUrl: null, text: null, warning: '读取图片失败' };
    }
  }

  if (kind === 'text') {
    try {
      const raw = await readAsText(file);
      const tooLong = raw.length > MAX_TEXT_BYTES;
      return {
        ...base,
        dataUrl: null,
        text: tooLong ? raw.slice(0, MAX_TEXT_BYTES) : raw,
        ...(tooLong ? { warning: `内容超过 ${MAX_TEXT_BYTES / 1024}KB，已截断` } : {}),
      };
    } catch {
      return { ...base, dataUrl: null, text: null, warning: '读取文件失败' };
    }
  }

  return {
    ...base,
    dataUrl: null,
    text: null,
    warning: '这是二进制文件，只能带上文件名',
  };
}

/** 附件的简短描述（显示在缩略图上）。 */
export function describeAttachment(att: Attachment): string {
  const kb = Math.max(1, Math.round(att.bytes / 1024));
  return `${att.name} · ${kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`}`;
}

/** 把附件拼成发给模型的文本（图片走 parts，文本直接注入）。 */
export function attachmentsToText(attachments: readonly Attachment[]): string {
  const blocks: string[] = [];
  for (const att of attachments) {
    if (att.kind === 'text' && att.text !== null) {
      blocks.push(`【附件：${att.name}】\n\`\`\`\n${att.text}\n\`\`\``);
    } else if (att.kind === 'binary') {
      blocks.push(`【附件：${att.name}】（二进制文件，${Math.round(att.bytes / 1024)}KB，无法读取内容）`);
    }
    // 图片不在这里拼——它走多模态通道，由 parts 承载
  }
  return blocks.join('\n\n');
}

/** 附件里的图片（转成多模态 parts 用）。 */
export function imageParts(attachments: readonly Attachment[]): Array<{
  type: 'image';
  dataUrl: string;
  name: string;
}> {
  return attachments
    .filter((a) => a.kind === 'image' && a.dataUrl !== null)
    .map((a) => ({ type: 'image' as const, dataUrl: a.dataUrl!, name: a.name }));
}

/** 管理附件列表的 hook。 */
export interface AttachmentState {
  readonly attachments: readonly Attachment[];
  readonly dragging: boolean;
  add: (files: FileList | readonly File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  setDragging: (value: boolean) => void;
}

export function useAttachments(): AttachmentState {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  // 用 ref 防止并发添加时丢更新
  const current = useRef<Attachment[]>([]);
  current.current = attachments;

  const add = useCallback(async (files: FileList | readonly File[]) => {
    const list = Array.from(files as ArrayLike<File>);
    if (list.length === 0) return;

    const converted = await Promise.all(list.map((f) => toAttachment(f)));
    const next = [...current.current, ...converted];
    current.current = next;
    setAttachments(next);
  }, []);

  const remove = useCallback((id: string) => {
    const next = current.current.filter((a) => a.id !== id);
    current.current = next;
    setAttachments(next);
  }, []);

  const clear = useCallback(() => {
    current.current = [];
    setAttachments([]);
  }, []);

  return { attachments, dragging, add, remove, clear, setDragging };
}
