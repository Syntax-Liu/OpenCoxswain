/**
 * 轻量 Markdown 渲染。
 *
 * 不引入 markdown 库的理由：Assistant 的输出结构是固定的（结论 / 做了什么 /
 * 验证了什么 / 需要你决定什么），支持的语法很少。自己实现能有针对性地
 * 处理中文场景（比如 `**结论**：` 后面紧跟全角冒号），也避免为一个
 * 渲染问题引入 100KB 依赖。
 *
 * 支持：
 * - `**粗体**`、`*斜体*`、`` `行内代码` ``
 * - `#` / `##` / `###` 标题
 * - `-` / `*` 列表（支持缩进层级）
 * - `1.` 有序列表
 * - ``` 代码块
 * - 表格在下面单独处理（Assistant 的汇报里可能出现）
 */
import type { ReactNode } from 'react';

export function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 代码块
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      i += 1; // 跳过结尾 ```
      out.push(
        <pre className="md-code" key={`k${key++}`}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = heading[2]!;
      const Tag = (level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4';
      out.push(
        <Tag className={`md-h md-h${level}`} key={`k${key++}`}>
          {inline(content)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // 表格：`| a | b |` 后跟 `|---|---|` 分隔行
    if (line.trim().startsWith('|') && lines[i + 1]?.trim().match(/^\|[\s:|-]+\|?$/)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2; // 跳过表头与分隔行
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(splitRow(lines[i]!));
        i += 1;
      }
      out.push(
        <table className="md-table" key={`k${key++}`}>
          <thead>
            <tr>
              {header.map((cell, ci) => (
                <th key={ci}>{inline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{inline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      out.push(<div className="md-gap" key={`k${key++}`} />);
      i += 1;
      continue;
    }

    // 无序列表
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const items: Array<{ indent: number; text: string }> = [];
      while (i < lines.length) {
        const m = /^(\s*)[-*+]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push({ indent: m[1]!.length, text: m[2]! });
        i += 1;
      }
      out.push(
        <ul className="md-ul" key={`k${key++}`}>
          {items.map((item, index) => (
            <li key={index} style={item.indent > 0 ? { marginLeft: `${Math.min(item.indent, 8) * 0.6}em` } : undefined}>
              {inline(item.text)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(m[2]!);
        i += 1;
      }
      out.push(
        <ol className="md-ol" key={`k${key++}`}>
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 普通段落
    out.push(
      <p className="md-p" key={`k${key++}`}>
        {inline(line)}
      </p>,
    );
    i += 1;
  }

  return out;
}

/** 把 `| a | b |` 切成 ['a','b']。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

/**
 * 行内元素：`**粗体**`、`*斜体*`、`` `代码` ``。
 *
 * 用一次扫描而不是多次 replace，避免 MARKDOWN **里套 `code`** 这类
 * 嵌套写法被拆坏。
 */
export function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`i${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code className="md-inline-code" key={`i${key++}`}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={`i${key++}`}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
