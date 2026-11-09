const CJK = /[\u3400-\u9fff]/;

/**
 * 中文按二元组切分，西文按单词切分。
 * FTS5 的 unicode61 分词器不切中文，索引与查询必须共用这套规则。
 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]+/g) ?? []) {
    if (!CJK.test(word)) tokens.add(word);
  }
  return [...tokens];
}

/** FTS5 索引正文：空格分隔的 token，避免中文整段成为一个不可检索的 token。 */
export function indexBody(text: string): string {
  const tokens = tokenize(text);
  return tokens.length > 0 ? tokens.join(' ') : text.toLowerCase();
}

/** FTS5 查询：token 之间取并集，评分在 TypeScript 侧完成。 */
export function matchExpression(tokens: string[]): string {
  return tokens
    .map((token) => `"${token.replace(/"/g, '')}"`)
    .filter((token) => token.length > 1)
    .join(' OR ');
}
