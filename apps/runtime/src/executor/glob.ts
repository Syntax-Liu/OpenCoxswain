/**
 * 把 glob 转成正则。
 *
 * 支持的语法（和常见工具一致）：
 * - `*`      任意字符，不跨目录
 * - `**`     任意字符，跨目录
 * - `?`      单个字符
 * - `{a,b}`  花括号里的任一项
 *
 * ## 为什么自己写
 *
 * 运行时零依赖。而且 glob 的正则转换很短，一百行以内。
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const ch = pattern[i]!;

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 可以匹配零层目录
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close > i) {
        const parts = pattern.slice(i + 1, close).split(',');
        out += `(?:${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close + 1;
        continue;
      }
    }

    // 其余字符转义后原样保留
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  return new RegExp(`^${out}$`, 'i');
}

/** 路径是否符合 glob（区分大小写不敏感，Windows 习惯）。 */
export function matchGlob(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relativePath);
}
