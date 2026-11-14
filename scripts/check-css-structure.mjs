/**
 * CSS 结构完整性检查。
 *
 * 花括号数量相等**不等于**结构正确——多一个 `}` 少一个 `{` 会互相抵消。
 * 这里做真正的括号配对扫描：深度不得为负，结束时必须归零，
 * 并报告每个异常出现的位置。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../apps/web/src/styles.css'));
const css = readFileSync(CSS_PATH, 'utf8');
// 去掉注释（保留长度以定位）
const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

let depth = 0;
const problems = [];
const stack = [];

for (let i = 0; i < clean.length; i += 1) {
  const ch = clean[i];
  if (ch === '{') {
    depth += 1;
    stack.push(i);
  } else if (ch === '}') {
    depth -= 1;
    if (depth < 0) {
      const line = clean.slice(0, i).split('\n').length;
      problems.push(`第 ${line} 行：多余的 }`);
      depth = 0;
    } else {
      stack.pop();
    }
  }
}

if (depth > 0) {
  for (const pos of stack) {
    const line = clean.slice(0, pos).split('\n').length;
    const snippet = css.slice(pos, pos + 60).split('\n')[0];
    problems.push(`第 ${line} 行：未闭合 { → ${snippet}`);
  }
}

// 额外检查：声明行末尾直接跟 } 的写法（我的脚本曾误拼出 `--x: v;}`）
// 注意：`height: auto;}` 这种原有写法语法合法，只作为**风格提示**，
// 仅当它出现在 `--token: var(...)}` 这类**令牌声明**上时才视为危险
// （说明闭合括号被脚本错误地拼进了声明行）。
const glued = [...clean.matchAll(/;\}/g)];
const dangerous = glued.filter((m) => {
  const lineStart = clean.lastIndexOf('\n', m.index) + 1;
  return /--[\w-]+\s*:/.test(clean.slice(lineStart, m.index));
});
for (const m of glued) {
  const line = clean.slice(0, m.index).split('\n').length;
  if (dangerous.includes(m)) {
    problems.push(`第 ${line} 行：令牌声明与 } 粘连（脚本拼坏了闭合括号）`);
  }
}

console.log(`文件: ${CSS_PATH}`);
console.log(`最终深度: ${depth}`);
console.log(`粘连写法: ${glued.length} 处（其中危险 ${dangerous.length} 处）`);

if (problems.length === 0) {
  console.log('结构完整 ✓');
  process.exit(0);
}

console.log(`\n发现 ${problems.length} 个问题：`);
for (const p of problems.slice(0, 20)) console.log('  ✗ ' + p);
process.exit(1);
