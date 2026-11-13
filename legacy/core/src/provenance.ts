import type { DeliverableProfile } from '@opencoxswain/shared';

export interface ProvenanceReport {
  verdict: 'passed' | 'failed' | 'unverified';
  anchors: string[];
  note: string;
}

export interface ProvenanceOptions {
  profile?: DeliverableProfile;
  /** 交付物正文；不可读时为 null。 */
  content: string | null;
  /** 由调用方校验后仍无法解析的锚点。 */
  unresolved?: string[];
  /** 每条 rubric 至少需要的锚点数。 */
  minAnchors?: number;
}

const ANCHOR_PATTERN = /\{\{\s*anchor\s*:\s*([^}]+)\}\}/gi;
const SOURCE_LINE_PATTERN = /(?:来源|出处|参考|source)\s*[:：]\s*(.+)$/i;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g;

function cleanRef(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[.,;，。；]+$/, '');
  if (!value || value.startsWith('#')) return null;
  return value;
}

/** 从交付物正文提取来源锚点：`{{anchor: ref}}`、markdown 链接、来源行。 */
export function extractAnchors(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(ANCHOR_PATTERN)) {
    const ref = cleanRef(match[1] ?? '');
    if (ref) refs.add(ref);
  }
  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    const ref = cleanRef(match[1] ?? '');
    if (ref) refs.add(ref);
  }
  for (const line of content.split(/\r?\n/)) {
    const match = SOURCE_LINE_PATTERN.exec(line);
    if (!match) continue;
    for (const part of (match[1] ?? '').split(/[,，、\s]+/)) {
      const ref = cleanRef(part);
      if (ref) refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * 非代码交付物的来源校验：只判断「有没有出处、出处是否可解析」，不判断文风与观点。
 * 锚点缺失 → unverified；锚点无法解析 → failed；全部可解析且数量达标 → passed。
 */
export function verifyProvenance(options: ProvenanceOptions): ProvenanceReport {
  if (options.content === null) {
    return { verdict: 'unverified', anchors: [], note: '交付物正文不可读，无法核对来源' };
  }
  const anchors = extractAnchors(options.content);
  if (anchors.length === 0) {
    return { verdict: 'unverified', anchors, note: '交付物没有来源锚点，交给人判断' };
  }
  const unresolved = options.unresolved ?? [];
  if (unresolved.length > 0) {
    return {
      verdict: 'failed',
      anchors,
      note: `锚点无法解析：${unresolved.slice(0, 5).join('、')}`,
    };
  }
  const minAnchors = options.minAnchors ?? (options.profile === 'document' ? 3 : 1);
  if (anchors.length < minAnchors) {
    return {
      verdict: 'unverified',
      anchors,
      note: `来源锚点不足（${anchors.length}/${minAnchors}）`,
    };
  }
  return { verdict: 'passed', anchors, note: `来源锚点 ${anchors.length} 条均可解析` };
}
