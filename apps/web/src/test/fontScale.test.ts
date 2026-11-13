/**
 * 界面字号缩放。
 *
 * 关键约束：**缩放必须作用在 4 档字号变量上**，
 * 不能只改某几处 font-size——那会重新变成"尺度不一"。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  fontScaleFactor,
  parseFontScale,
} from '../components/fontScale.js';

describe('档位', () => {
  it('四档，从小到大', () => {
    assert.equal(FONT_SCALE_OPTIONS.length, 4);
    const factors = FONT_SCALE_OPTIONS.map((o) => o.factor);
    for (let i = 1; i < factors.length; i += 1) {
      assert.ok(factors[i]! > factors[i - 1]!, '倍数必须递增');
    }
  });

  it('"标准"档倍数是 1（基准）', () => {
    assert.equal(fontScaleFactor('standard'), 1);
  });

  it('**默认档是"大"**（实测标准档在 2K 屏上偏小）', () => {
    assert.equal(DEFAULT_FONT_SCALE, 'large');
    assert.ok(fontScaleFactor(DEFAULT_FONT_SCALE) > 1);
  });

  it('每档都有中文标签', () => {
    for (const o of FONT_SCALE_OPTIONS) {
      assert.ok(o.label.length > 0, `${o.id} 缺标签`);
    }
  });
});

describe('解析存储值', () => {
  it('合法值原样返回', () => {
    assert.equal(parseFontScale('small'), 'small');
    assert.equal(parseFontScale('xlarge'), 'xlarge');
  });

  it('**非法值退回默认**，不崩', () => {
    assert.equal(parseFontScale('huge'), DEFAULT_FONT_SCALE);
    assert.equal(parseFontScale(''), DEFAULT_FONT_SCALE);
    assert.equal(parseFontScale(null), DEFAULT_FONT_SCALE);
    assert.equal(parseFontScale(undefined), DEFAULT_FONT_SCALE);
  });
});

describe('应用', () => {
  it('**只改 --font-scale 一个变量**', () => {
    const touched = new Map();
    const fakeRoot = {
      style: {
        setProperty: (k: string, v: string) => touched.set(k, v),
      },
    } as unknown as HTMLElement;

    // 延迟导入，避免模块顶层引用 document
    return import('../components/fontScale.js').then(({ applyFontScale }) => {
      applyFontScale('xlarge', fakeRoot);
      assert.equal(touched.size, 1, '只应设置一个变量');
      assert.ok(touched.has('--font-scale'));
      assert.equal(touched.get('--font-scale'), String(fontScaleFactor('xlarge')));
    });
  });
});
