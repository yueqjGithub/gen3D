import { useEffect, useState, type FormEvent } from 'react';
import type { ModelSelection } from '@agent3d/shared';
import type { ApiClient } from '../../api/client';
import type { ModelSettings as ModelSettingsData, ProviderOption } from '../../api/types';

export interface ModelSettingsProps {
  api: ApiClient;
}

function providerFor(
  providers: ProviderOption[],
  providerId: string,
): ProviderOption | undefined {
  return providers.find((provider) => provider.id === providerId);
}

export function ModelSettings({ api }: ModelSettingsProps) {
  const [settings, setSettings] = useState<ModelSettingsData | null>(null);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [chatKey, setChatKey] = useState('');
  const [imageKey, setImageKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const data = await api.getModelSettings();
    setSettings(data);
    setSelection(data.selection);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api.getModelSettings()
      .then((data) => {
        if (active) {
          setSettings(data);
          setSelection(data.selection);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : '无法读取模型设置。');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, loadAttempt]);

  function updateSelection(role: 'chat' | 'image', patch: Partial<ModelSelection['chat']>) {
    setSelection((current) => current && ({
      ...current,
      [role]: { ...current[role], ...patch },
    }));
  }

  function selectProvider(role: 'chat' | 'image', providerId: string) {
    const provider = settings && providerFor(settings.providers, providerId);
    if (!provider) {
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
      apiKeyConfigured: false,
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
      setNotice('模型设置已保存。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '模型设置保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(role: 'chat' | 'image') {
    if (!selection) {
      return;
    }
    const config = selection[role];
    const key = role === 'chat' ? chatKey : imageKey;
    if (!key.trim()) {
      setError('请输入 API key；留空不会修改已保存的凭据。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveCredential(config.providerId, key);
      if (role === 'chat') {
        setChatKey('');
      } else {
        setImageKey('');
      }
      await refresh();
      setNotice(`${role === 'chat' ? '对话' : '生图'} API key 已安全保存。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'API key 保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function removeKey(role: 'chat' | 'image') {
    if (!selection) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.removeCredential(selection[role].providerId);
      await refresh();
      setNotice('API key 已移除。');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'API key 移除失败。');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p role="status">正在读取模型设置…</p>;
  }

  if (error && (!settings || !selection)) {
    return (
      <section className="settings-section" aria-label="模型设置">
        <p className="inline-error" role="alert">{error}</p>
        <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
          重试读取模型设置
        </button>
      </section>
    );
  }

  if (!settings || !selection) {
    return <p role="status">正在读取模型设置…</p>;
  }

  return (
    <section className="settings-section" aria-label="模型设置">
      <header className="settings-section__header">
        <div>
          <span className="settings-section__eyebrow">连接偏好</span>
          <h2>模型设置</h2>
        </div>
        <p>API key 仅保存在系统安全存储中，不会回显。</p>
      </header>

      <form className="model-settings" onSubmit={(event) => void saveModels(event)}>
        {(['chat', 'image'] as const).map((role) => {
          const config = selection[role];
          const provider = providerFor(settings.providers, config.providerId);
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
                {settings.providers.map((option) => (
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
              <label htmlFor={`${role}-api-key`}>
                {isChat ? 'Chat API key' : 'Image API key'}
                {config.apiKeyConfigured && <span className="credential-state">已配置</span>}
              </label>
              <input
                id={`${role}-api-key`}
                aria-label={isChat ? 'Chat API key input' : 'Image API key input'}
                type="password"
                autoComplete="new-password"
                value={isChat ? chatKey : imageKey}
                onChange={(event) => isChat
                  ? setChatKey(event.target.value)
                  : setImageKey(event.target.value)}
                placeholder={config.apiKeyConfigured ? '留空以保留已保存的 key' : '输入 API key'}
                disabled={busy}
              />
              <div className="model-settings__credential-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void saveKey(role)}
                  aria-label={`保存 ${isChat ? 'Chat' : 'Image'} API key`}
                >
                  保存 API key
                </button>
                {config.apiKeyConfigured && (
                  <button type="button" disabled={busy} onClick={() => void removeKey(role)}>
                    移除 key
                  </button>
                )}
              </div>
            </fieldset>
          );
        })}
        <button className="primary-button" type="submit" disabled={busy}>
          保存模型设置
        </button>
      </form>

      {notice && <p className="success-note" role="status">{notice}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}
