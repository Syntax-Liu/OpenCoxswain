import { useEffect, useState } from 'react';

import type { ApiClient, ModelConfigDto, ModelParamsDto, SettingsStatus } from '../api.js';
import { Button, OptionItem, Select, TextButton, TextInput } from '../ui/index.js';

/**
 * 模型设置面板：多模型 + 参数 + 角色绑定。
 *
 * 布局：
 * ```
 * 模型列表        [新增模型]
 *  ┌─ DeepSeek Chat  ← 选中
 *  ┌─ 便宜模型
 *
 * 选中模型的详情
 *   名称 / 端点 / 密钥 / 模型名
 *   参数：思考强度、上下文、工具轮数、Temperature、Top P、图片输入
 *
 * 角色绑定
 *   Supervisor → [下拉]
 *   Assistant  → [下拉]
 *   Agent      → [下拉]
 * ```
 *
 * **参数挂在每个模型上**：不同厂商支持的不同，全局参数会打架。
 */

const EMPTY_PARAMS: ModelParamsDto = {};

function newModel(): ModelConfigDto {
  return {
    id: `mdl_${Date.now().toString(36)}`,
    name: '新模型',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    params: { ...EMPTY_PARAMS },
  };
}

export function ModelSettingsPanel(props: {
  api: ApiClient;
  status: SettingsStatus;
  onSaved: (status: SettingsStatus) => void;
}): JSX.Element {
  const [models, setModels] = useState<ModelConfigDto[]>([]);
  const [roles, setRoles] = useState<{ supervisor: string | null; assistant: string | null; agent: string | null }>(
    { supervisor: null, assistant: null, agent: null },
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storage, setStorage] = useState<string>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void props.api
      .models()
      .then((r) => {
        setModels([...r.settings.models]);
        setRoles(r.settings.roles);
        setStorage(r.storage);
        setSelectedId(r.settings.models[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '读不到模型配置'));
  }, [props.api]);

  const selected = models.find((m) => m.id === selectedId) ?? null;

  const update = (patch: Partial<ModelConfigDto>): void => {
    if (!selected) return;
    setModels((prev) => prev.map((m) => (m.id === selected.id ? { ...m, ...patch } : m)));
    setSaved(false);
  };

  const updateParam = (patch: Partial<ModelParamsDto>): void => {
    if (!selected) return;
    update({ params: { ...selected.params, ...patch } });
  };

  const addModel = (): void => {
    const m = newModel();
    setModels((prev) => [...prev, m]);
    setSelectedId(m.id);
    setSaved(false);
  };

  const removeModel = (id: string): void => {
    setModels((prev) => prev.filter((m) => m.id !== id));
    // 解绑引用它的角色，避免悬空指向
    setRoles((prev) => ({
      supervisor: prev.supervisor === id ? null : prev.supervisor,
      assistant: prev.assistant === id ? null : prev.assistant,
      agent: prev.agent === id ? null : prev.agent,
    }));
    if (selectedId === id) setSelectedId(null);
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await props.api.saveModels({ models, roles });
      setStorage(r.storage);
      setSaved(true);
      setError(null);
      // 模型可能改变"是否已配置"，刷新一次状态
      const status = await props.api.settings();
      props.onSaved(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-block">
      <h2>模型</h2>
      <p className="muted small">
        可以配多个模型，并给 Supervisor / Assistant / Agent 分别指定。
        参数按模型单独设置——不同厂商支持的参数不一样。
      </p>

      {storage === 'plaintext' && (
        <p className="notice">
          当前<b>没有可用的系统加密服务</b>，密钥会以明文写入配置文件。
          在打包版（含 DPAPI 服务）里会自动改为密文。
        </p>
      )}

      <div className="model-layout">
        {/* 左：模型列表 */}
        <div className="model-list">
          {models.length === 0 && (
            <p className="muted small model-empty">
              还没有模型。点「新增模型」加一个，或先用下面「沿用当前密钥」。
            </p>
          )}
          {models.map((m) => (
            <OptionItem
              key={m.id}
              variant="model-item"
              selected={m.id === selectedId}
              onClick={() => setSelectedId(m.id)}
            >
              <span className="model-item-name">{m.name || '(未命名)'}</span>
              <span className="model-item-id">{m.model}</span>
            </OptionItem>
          ))}
          <Button onClick={addModel} variant="ghost" size="sm" className="model-add">＋ 新增模型
          </Button>
        </div>

        {/* 右：选中模型的详情 */}
        <div className="model-detail">
          {!selected && <p className="muted small">选一个模型，或新增一个。</p>}

          {selected && (
            <>
              <div className="model-detail-head">
                <h3>{selected.name || '未命名'}</h3>
                <TextButton onClick={() => removeModel(selected.id)} className="danger-link">删除
                </TextButton>
              </div>

              <label className="field">
                <span>显示名</span>
                <TextInput value={selected.name} onChange={(e) => update({ name: e.target.value })} />
              </label>

              <label className="field">
                <span>端点</span>
                <TextInput value={selected.baseUrl}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => update({ baseUrl: e.target.value })} />
              </label>

              <label className="field">
                <span>模型名</span>
                <TextInput value={selected.model}
                  placeholder="deepseek-chat"
                  onChange={(e) => update({ model: e.target.value })} />
              </label>

              <label className="field">
                <span>API Key</span>
                <TextInput type="password"
                  value={selected.apiKey}
                  placeholder={selected.apiKey ? '已填写' : 'sk-...'}
                  onChange={(e) => update({ apiKey: e.target.value })} />
              </label>

              <h4 className="settings-subhead">参数</h4>
              <p className="muted small">留空表示用服务端默认值，不替它做决定。</p>

              <label className="field">
                <span>思考强度</span>
                <Select
                  value={selected.params.reasoningEffort ?? ''}
                  options={[{ value: '', label: '默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }]}
                  onChange={(v) =>
                    updateParam({
                      reasoningEffort: v === '' ? undefined : (v as 'low' | 'medium' | 'high'),
                    })
                  }
                  ariaLabel="思考强度"
                />
              </label>

              <div className="field-row">
                <label className="field">
                  <span>Temperature</span>
                  <TextInput type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={selected.params.temperature ?? ''}
                    placeholder="0–2"
                    onChange={(e) =>
                      updateParam({
                        temperature: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    } />
                </label>
                <label className="field">
                  <span>Top P</span>
                  <TextInput type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selected.params.topP ?? ''}
                    placeholder="0–1"
                    onChange={(e) =>
                      updateParam({ topP: e.target.value === '' ? undefined : Number(e.target.value) })
                    } />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>上下文长度</span>
                  <TextInput type="number"
                    min={1024}
                    value={selected.params.contextLength ?? ''}
                    placeholder="服务端默认"
                    onChange={(e) =>
                      updateParam({
                        contextLength: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    } />
                </label>
                <label className="field">
                  <span>工具调用轮数</span>
                  <TextInput type="number"
                    min={1}
                    max={200}
                    value={selected.params.maxToolRounds ?? ''}
                    placeholder="默认 40"
                    onChange={(e) =>
                      updateParam({
                        maxToolRounds: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    } />
                </label>
              </div>

              <label className="check-row">
                <TextInput type="checkbox"
                  checked={selected.params.supportsImages ?? false}
                  onChange={(e) => updateParam({ supportsImages: e.target.checked })} />
                <span>支持图片输入</span>
              </label>
            </>
          )}
        </div>
      </div>

      {/* 角色绑定 */}
      <h3 className="settings-subhead">角色绑定</h3>
      <p className="muted small">
        每个角色用哪个模型。不绑定的角色会用「沿用当前密钥」那套默认配置。
      </p>
      <div className="role-grid">
        {(
          [
            ['supervisor', 'Supervisor', '跨项目统筹，要判断力'],
            ['assistant', 'Assistant', '项目常驻，跟用户对话'],
            ['agent', 'Agent', '干具体活，要快和便宜'],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="role-row">
            <span className="role-name">{label}</span>
            <span className="role-hint muted small">{hint}</span>
            <Select
                value={roles[key] ?? ''}
                options={[
                  { value: '', label: '（默认配置）' },
                  ...models.map((mm) => ({ value: mm.id, label: mm.name || mm.id })),
                ]}
                onChange={(v) => {
                  setRoles((prev) => ({ ...prev, [key]: v || null }));
                  setSaved(false);
                }}
                ariaLabel="绑定模型"
              />
          </label>
        ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="settings-actions">
        {saved && <span className="saved-hint">已保存</span>}
        <Button onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存模型设置'}</Button>
      </div>
    </section>
  );
}
