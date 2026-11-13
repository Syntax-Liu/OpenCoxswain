/**
 * 自检扫描。
 *
 * 这个模块针对的是**"测试全绿但功能不工作"**这一类问题。
 * 每一类都对应这一轮真实踩过的坑。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findSilentSwallow,
  findUncoveredWiring,
  renderFindings,
  runSelfCheck,
} from '../selfcheck/scan.js';

const file = (path: string, text: string) => ({ path, text });

describe('**静默吞错**', () => {
  it('空 catch 会被指出来', () => {
    const f = file(
      'a.ts',
      `try {
  await save();
} catch {
}`,
    );
    const found = findSilentSwallow([f]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 3);
    assert.match(found[0]!.why, /完全没有线索/);
  });

  it('带注释的空 catch 不算（那是明确说明要忽略）', () => {
    const f = file(
      'a.ts',
      `try {
  await save();
} catch {
  /* 一个都连不上就算了 */
}`,
    );
    assert.equal(findSilentSwallow([f]).length, 0);
  });

  it('catch 里有语句就不算', () => {
    const f = file(
      'a.ts',
      `try {
  await save();
} catch (e) {
  log(e);
}`,
    );
    assert.equal(findSilentSwallow([f]).length, 0);
  });

  it('说明里给出这次踩坑的教训', () => {
    const f = file('a.ts', 'try {\n  x();\n} catch {\n}');
    assert.match(findSilentSwallow([f])[0]!.why, /六七轮/);
  });
});

describe('**可选字段的传递**', () => {
  it('同一字段在多处传递时提示确认', () => {
    const f = file(
      'a.ts',
      `const a = {
  ...(options.snapshots ? { snapshots: options.snapshots } : {}),
};
const b = {
  ...(options.snapshots ? { snapshots: options.snapshots } : {}),
};`,
    );
    const found = findUncoveredWiring([f]);
    assert.equal(found.length, 1);
    assert.match(found[0]!.why, /snapshots/);
    assert.match(found[0]!.why, /类型检查不会报错/);
  });

  it('只传一次不提示（没有漏的机会）', () => {
    const f = file(
      'a.ts',
      `const a = { ...(options.snapshots ? { snapshots: options.snapshots } : {}) };`,
    );
    assert.equal(findUncoveredWiring([f]).length, 0);
  });
});

describe('排序与渲染', () => {
  it('按严重度排序（medium 在 low 前）', () => {
    const files = [
      file('a.ts', 'const a = { ...(o.x ? { x: o.x } : {}) };\nconst b = { ...(o.x ? { x: o.x } : {}) };'),
      file('b.ts', 'try {\n  y();\n} catch {\n}'),
    ];
    const found = runSelfCheck(files);
    assert.equal(found[0]?.severity, 'medium');
  });

  it('没有问题时不乱报', () => {
    assert.equal(runSelfCheck([file('a.ts', 'const x = 1;')]).length, 0);
    assert.match(renderFindings([]), /没有发现问题/);
  });

  it('渲染带位置和理由', () => {
    const text = renderFindings(findSilentSwallow([file('a.ts', 'try {\n  x();\n} catch {\n}')]));
    assert.match(text, /a\.ts:3/);
    assert.match(text, /→/);
  });
});
