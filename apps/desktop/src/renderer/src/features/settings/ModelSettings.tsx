import { useEffect, useState, type FormEvent } from 'react';
import type { ModelSelection } from '@agent3d/shared';
import { api } from '../../api/client';
import { useModelSettings } from './ModelContext';

/** 模型选择保存到服务端；每个模型的 API Key 只保存在客户端。 */
export function ModelSettings() {
  const { selection: currentSelection, providers, apiKeys, setApiKey, setSelection: setCurrentSelection, error: loadError, reload } = useModelSettings();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setSelection(currentSelection);
  }, [currentSelection]);

  function updateSelection(role: 'chat' | 'image', patch: Partial<ModelSelection['chat']>) {
    setSelection((current) => current && ({
      ...current,
      [role]: { ...current[role], ...patch },
    }));
  }

  function selectProvider(role: 'chat' | 'image', providerId: string) {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
      setError('未找到所选模型服务商，请重新读取模型设置。');
      return;
    }
    const modelId = provider.models[role][0];
    if (!modelId) {
      setError(`${provider.name} 暂无可用的${role === 'chat' ? '对话' : '生图'}模型。`);
      return;
    }
    setError(null);
    updateSelection(role, {
      providerId,
      modelId,
      baseURL: provider.baseURL,
    });
  }

  async function saveModels(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveModelSettings(selection);
      setSelection(saved);
      setCurrentSelection(saved);
      setNotice('模型设置已保存。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '模型设置保存失败。');
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !selection) {
    return (
      <section className="settings-section" aria-label="模型设置">
        <p className="inline-error" role="alert">{loadError}</p>
        <button type="button" onClick={reload}>
          重试读取模型设置
        </button>
      </section>
    );
  }

  if (!selection) {
    return <p role="status">正在读取模型设置…</p>;
  }

  return (
    <section className="settings-section" aria-label="模型设置">
      <header className="settings-section__header">
        <div>
          <span className="settings-section__eyebrow">连接偏好</span>
          <h2>模型设置</h2>
        </div>
        <p>API Key 仅保存在当前客户端，发送消息时随请求使用。</p>
      </header>

      <form className="model-settings" onSubmit={(event) => void saveModels(event)}>
        {(['chat', 'image'] as const).map((role) => {
          const config = selection[role];
          const provider = providers.find((item) => item.id === config.providerId);
          const models = provider?.models[role] ?? [];
          const isChat = role === 'chat';
          return (
            <fieldset className="model-settings__card" key={role}>
              <legend>{isChat ? '对话模型' : '生图模型'}</legend>
              <label htmlFor={`${role}-provider`}>服务商</label>
              <select
                id={`${role}-provider`}
                value={config.providerId}
                onChange={(event) => selectProvider(role, event.target.value)}
                disabled={busy}
              >
                {providers.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>

              <label htmlFor={`${role}-model`}>模型</label>
              <select
                id={`${role}-model`}
                value={config.modelId}
                onChange={(event) => updateSelection(role, { modelId: event.target.value })}
                disabled={busy || models.length === 0}
              >
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>

              <label htmlFor={`${role}-base-url`}>Base URL</label>
              <input
                id={`${role}-base-url`}
                type="url"
                value={config.baseURL}
                onChange={(event) => updateSelection(role, { baseURL: event.target.value })}
                disabled={busy}
              />
              <label htmlFor={`${role}-api-key`}>API Key</label>
              <input
                id={`${role}-api-key`}
                type="password"
                autoComplete="off"
                value={apiKeys[`${config.providerId}:${config.modelId}`] ?? ''}
                onChange={(event) => {
                  try {
                    setApiKey(config.providerId, config.modelId, event.target.value);
                    setError(null);
                  } catch (storageError) {
                    console.error('保存本地模型密钥失败：', storageError);
                    setError('无法保存 API Key，请检查客户端存储。');
                  }
                }}
                disabled={busy}
              />
            </fieldset>
          );
        })}
        <button className="primary-button" type="submit" disabled={busy}>
          保存模型设置
        </button>
      </form>

      {notice && <p className="success-note" role="status">{notice}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {loadError && <p className="inline-error" role="alert">{loadError}</p>}
    </section>
  );
}
