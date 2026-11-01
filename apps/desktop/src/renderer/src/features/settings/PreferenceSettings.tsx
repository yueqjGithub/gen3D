import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client';

export interface PreferenceSettingsProps {
  api: ApiClient;
}

export function PreferenceSettings({ api }: PreferenceSettingsProps) {
  const [preferences, setPreferences] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setPreferences(await api.getPreferences());
  }

  useEffect(() => {
    let active = true;
    void api.getPreferences()
      .then((result) => {
        if (active) {
          setPreferences(result);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : '无法读取本地偏好。');
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreferences(await api.savePreference(key, value));
      setKey('');
      setValue('');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '偏好保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function remove(preferenceKey: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deletePreference(preferenceKey);
      await refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '偏好删除失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-label="偏好记忆">
      <header className="settings-section__header">
        <div>
          <span className="settings-section__eyebrow">仅保存在本机</span>
          <h2>偏好记忆</h2>
        </div>
        <p>Agent 提出的建议不会自动写入，你可以在对话中逐条确认。</p>
      </header>
      <form className="preference-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="preference-key">偏好名称</label>
        <input
          id="preference-key"
          value={key}
          maxLength={80}
          onChange={(event) => setKey(event.target.value)}
          required
        />
        <label htmlFor="preference-value">偏好内容</label>
        <input
          id="preference-value"
          value={value}
          maxLength={500}
          onChange={(event) => setValue(event.target.value)}
          required
        />
        <button type="submit" disabled={busy}>保存偏好</button>
      </form>
      <ul className="preference-list" aria-label="已保存偏好">
        {Object.entries(preferences).map(([preferenceKey, preferenceValue]) => (
          <li key={preferenceKey}>
            <div>
              <strong>{preferenceKey}</strong>
              <span>{preferenceValue}</span>
            </div>
            <button
              type="button"
              onClick={() => void remove(preferenceKey)}
              disabled={busy}
              aria-label={`删除偏好 ${preferenceKey}`}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}
