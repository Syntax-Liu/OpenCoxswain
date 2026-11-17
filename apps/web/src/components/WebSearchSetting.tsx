/**
 * 联网搜索设置。
 *
 * ## 为什么需要这块
 *
 * `web_search` 需要一个搜索服务（endpoint + key）。
 * 没有界面的话，用户只能手工写 `~/.opencoxswain/search.json`。
 *
 * ## key 的处理
 *
 * **不回显**。接口只返回 `configured: true/false`。
 * 保存时如果 key 输入框是空的，保留原来的 key——用户改 endpoint 时
 * 不需要重新输入一遍密钥。
 */
import { useEffect, useState } from 'react';

import type { ApiClient } from '../api.js';
import { Button, TextInput } from '../ui/index.js';

export interface WebSearchSettingProps {
  readonly api: ApiClient;
}

export function WebSearchSetting(props: WebSearchSettingProps): JSX.Element {
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    props.api
      .searchSettings()
      .then((s) => {
        if (!alive) return;
        setEndpoint(s.endpoint);
        setConfigured(s.configured);
      })
      .catch(() => {
        /* 拉不到就当没配 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      const r = await props.api.setSearchSettings({ endpoint, apiKey });
      setMessage(r.message);
      // 保存成功后重新拉一次，确认 configured 状态
      const s = await props.api.searchSettings();
      setConfigured(s.configured);
      // 密钥不回显：保存成功后清空输入框
      setApiKey('');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section">
      <h3>联网搜索</h3>
      <p className="muted small">
        配好之后，Agent 可以用 <code>web_search</code> 搜网页、用 <code>read_url</code> 读页面。
        <br />
        <strong>没配也不影响其他功能</strong>——只是搜不了而已，Agent 会明确说"搜不了"，
        不会编造结果。
      </p>

      <label className="field">
        <span>搜索服务地址</span>
        <TextInput type="text"
          value={endpoint}
          placeholder="https://api.example.com/search"
          onChange={(e) => setEndpoint(e.target.value)}
          disabled={loading} />
      </label>

      <label className="field">
        <span>密钥</span>
        <TextInput type="password"
          value={apiKey}
          placeholder={configured ? '已保存（留空则不修改）' : 'sk-...'}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={loading} />
      </label>

      <p className="muted small">
        接口约定：<code>POST {'{ endpoint }'}</code>，body 是{' '}
        <code>{'{ "query": "...", "count": 5 }'}</code>，返回{' '}
        <code>{'{ "results": [{ "title", "url", "snippet" }] }'}</code>。
      </p>

      <div className="settings-actions">
        {configured && <span className="saved-hint">已配置</span>}
        {message && <span className="saved-hint">{message}</span>}
        <Button onClick={() => void save()} disabled={saving || loading}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </div>
  );
}
