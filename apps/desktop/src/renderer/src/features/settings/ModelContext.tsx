import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ModelSelection } from '@agent3d/shared';
import { z } from 'zod';
import { api } from '../../api/client';
import type { ProviderOption } from '../../api/types';

const storageKey = 'agent3d-api-keys';

interface ModelState {
  selection: ModelSelection | null;
  providers: ProviderOption[];
  apiKeys: Record<string, string>;
  error: string | null;
  reload(): void;
  setSelection(selection: ModelSelection): void;
  setApiKey(providerId: string, modelId: string, apiKey: string): void;
}

const ModelContext = createContext<ModelState | null>(null);

/** 模型选择从服务端读取；密钥只存放在 Electron renderer 的 localStorage。 */
export function ModelProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setApiKeys(z.record(z.string(), z.string()).parse(JSON.parse(saved)));
    } catch (storageError) {
      console.error('读取本地模型密钥失败：', storageError);
      setError('无法读取本地 API Key，请检查客户端存储。');
    }
  }, [attempt]);

  useEffect(() => {
    let active = true;
    void api.getModelSettings().then((settings) => {
      if (active) {
        setSelection(settings.selection);
        setProviders(settings.providers);
      }
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : '无法读取模型设置。');
    });
    return () => { active = false; };
  }, [attempt]);

  function setApiKey(providerId: string, modelId: string, apiKey: string) {
    const updated = { ...apiKeys, [`${providerId}:${modelId}`]: apiKey };
    // 写入成功后再更新状态；存储失败由设置界面显示。
    localStorage.setItem(storageKey, JSON.stringify(updated));
    setApiKeys(updated);
  }

  return (
    <ModelContext.Provider value={{
      selection, providers, apiKeys, error,
      reload: () => { setError(null); setAttempt((value) => value + 1); },
      setSelection, setApiKey,
    }}>
      {children}
    </ModelContext.Provider>
  );
}

export function useModelSettings() {
  const context = useContext(ModelContext);
  if (!context) throw new Error('ModelProvider is missing.');
  return context;
}
