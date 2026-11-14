import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { globToRegExp, matchGlob } from '../executor/glob.js';

describe('globToRegExp', () => {
  it('* 不跨目录', () => {
    assert.equal(matchGlob('a.ts', '*.ts'), true);
    assert.equal(matchGlob('src/a.ts', '*.ts'), false);
    assert.equal(matchGlob('src/a.ts', 'src/*.ts'), true);
    assert.equal(matchGlob('src/deep/a.ts', 'src/*.ts'), false);
  });

  it('** 跨目录', () => {
    assert.equal(matchGlob('a.ts', '**/*.ts'), true);
    assert.equal(matchGlob('src/a.ts', '**/*.ts'), true);
    assert.equal(matchGlob('src/deep/deeper/a.ts', '**/*.ts'), true);
  });

  it('? 匹配单字符', () => {
    assert.equal(matchGlob('a.ts', '?.ts'), true);
    assert.equal(matchGlob('ab.ts', '?.ts'), false);
  });

  it('花括号展开', () => {
    assert.equal(matchGlob('a.ts', '*.{ts,tsx}'), true);
    assert.equal(matchGlob('a.tsx', '*.{ts,tsx}'), true);
    assert.equal(matchGlob('a.js', '*.{ts,tsx}'), false);
  });

  it('区分大小写不敏感（Windows 习惯）', () => {
    assert.equal(matchGlob('SRC/A.TS', 'src/*.ts'), true);
  });

  it('点号要转义', () => {
    // "a.ts" 里的 . 如果没转义，会匹配 "aXts"
    assert.equal(matchGlob('aXts', 'a.ts'), false);
    assert.equal(matchGlob('a.ts', 'a.ts'), true);
  });

  it('返回的是锚定正则', () => {
    const re = globToRegExp('*.ts');
    assert.equal(re.test('a.ts'), true);
    assert.equal(re.test('a.ts.bak'), false, '必须整体匹配');
  });

  it('常见真实模式', () => {
    assert.equal(matchGlob('apps/web/src/App.tsx', 'apps/web/**/*.tsx'), true);
    assert.equal(matchGlob('apps/runtime/src/executor/diff.ts', 'apps/runtime/src/**/*.ts'), true);
    assert.equal(matchGlob('package.json', '*.json'), true);
    assert.equal(matchGlob('apps/web/package.json', '*.json'), false);
  });
});
