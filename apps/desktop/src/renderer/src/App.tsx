import { useEffect, useMemo, useState } from 'react';
import type { AssetArtifact, Conversation } from '@agent3d/shared';
import { createApiClient, type ApiClient } from './api/client';
import type { ChatUIMessage } from './api/types';
import { AssetPanel } from './features/assets/AssetPanel';
import { ChatView } from './features/chat/ChatView';
import { ConversationSidebar } from './features/conversations/ConversationSidebar';
import { ModelSettings } from './features/settings/ModelSettings';
import { PreferenceSettings } from './features/settings/PreferenceSettings';

export interface AppProps {
  api?: ApiClient;
}

export default function App({ api: providedApi }: AppProps) {
  const apiState = useMemo(() => {
    if (providedApi) {
      return { api: providedApi, error: null };
    }
    try {
      return { api: createApiClient(), error: null };
    } catch (error) {
      return {
        api: null,
        error: error instanceof Error ? error.message : '本地 API 不可用。',
      };
    }
  }, [providedApi]);
  const api = apiState.api;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  const [artifact, setArtifact] = useState<AssetArtifact | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'models' | 'preferences'>('models');
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(apiState.error);

  useEffect(() => {
    if (!api) {
      setLoadingConversations(false);
      return;
    }
    let active = true;
    void api.listConversations()
      .then((loaded) => {
        if (active) {
          setConversations(loaded);
          setActiveConversationId((current) => current ?? loaded[0]?.id ?? null);
          setError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : '无法读取会话列表。');
        }
      })
      .finally(() => {
        if (active) {
          setLoadingConversations(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  const activeConversation = conversations.find(({ id }) => id === activeConversationId) ?? null;

  useEffect(() => {
    if (!api || !activeConversation) {
      setMessages([]);
      setArtifact(null);
      setLoadingMessages(false);
      return;
    }
    let active = true;
    setMessages([]);
    setArtifact(null);
    setLoadingMessages(true);
    void api.getMessages(activeConversation.id)
      .then((loaded) => {
        if (!active) {
          return;
        }
        setMessages(loaded);
        const assets = loaded.flatMap((message) =>
          message.parts.flatMap((part) => part.type === 'data-asset' ? [part.data] : []));
        setArtifact(assets.at(-1) ?? null);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : '无法读取会话消息。');
        }
      })
      .finally(() => {
        if (active) {
          setLoadingMessages(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, activeConversation?.id]);

  async function createConversation() {
    if (!api) {
      return;
    }
    setError(null);
    try {
      const created = await api.createConversation();
      setConversations((current) => [created, ...current]);
      setActiveConversationId(created.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '无法新建会话。');
    }
  }

  async function renameConversation(id: string, title: string) {
    if (!api) {
      return;
    }
    const updated = await api.renameConversation(id, title);
    setConversations((current) => current.map((conversation) =>
      conversation.id === id ? updated : conversation));
  }

  async function deleteConversation(id: string) {
    if (!api) {
      return;
    }
    await api.deleteConversation(id);
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setConversations(remaining);
    if (activeConversationId === id) {
      setActiveConversationId(remaining[0]?.id ?? null);
    }
  }

  async function openAsset(artifactId: string) {
    if (!api) {
      return;
    }
    try {
      const details = await api.getArtifact(artifactId);
      setArtifact(details.artifact);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取资产。');
    }
  }

  if (!api) {
    return (
      <main className="app-error">
        <span className="app-error__eyebrow">本地服务未连接</span>
        <h1>无法连接到创作工作台</h1>
        <p role="alert">{error ?? '请重启桌面应用后重试。'}</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <ConversationSidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={setActiveConversationId}
        onCreate={() => void createConversation()}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />

      <section className="workspace">
        <div className="workspace__toolbar">
          <span>从灵感到可审阅的 3D 资产</span>
          <button type="button" className="settings-button" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>

        {error && <p className="workspace__error" role="alert">{error}</p>}
        {loadingConversations ? (
          <p className="workspace__loading" role="status">正在读取本机会话…</p>
        ) : activeConversation ? (
          <div className="workspace__content">
            <div className="workspace__chat">
              {loadingMessages ? (
                <p className="workspace__loading" role="status">正在读取对话…</p>
              ) : (
                <ChatView
                  key={activeConversation.id}
                  api={api}
                  conversation={activeConversation}
                  initialMessages={messages}
                  onArtifactChange={setArtifact}
                  onOpenAsset={(artifactId) => void openAsset(artifactId)}
                />
              )}
            </div>
            {artifact && (
              <AssetPanel
                api={api}
                artifact={artifact}
                onChange={setArtifact}
              />
            )}
          </div>
        ) : (
          <section className="workspace__welcome">
            <span className="workspace__welcome-mark" aria-hidden="true">◌</span>
            <span className="workspace__eyebrow">3D ASSET STUDIO</span>
            <h1>让灵感，长出形状。</h1>
            <p>从一张图片、一份文档，或一句描述开始。</p>
            <button type="button" className="primary-button" onClick={() => void createConversation()}>
              开始新的创作 <span aria-hidden="true">↗</span>
            </button>
            <small>你的会话与偏好将保存在这台设备上。</small>
          </section>
        )}
      </section>

      {settingsOpen && (
        <div
          className="settings-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <section className="settings-drawer" role="dialog" aria-modal="true" aria-label="设置">
            <header className="settings-drawer__header">
              <div>
                <span>工作台配置</span>
                <h2>设置</h2>
              </div>
              <button
                type="button"
                aria-label="关闭设置"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </header>
            <nav className="settings-tabs" aria-label="设置类别">
              <button
                type="button"
                aria-pressed={settingsTab === 'models'}
                onClick={() => setSettingsTab('models')}
              >
                模型与凭据
              </button>
              <button
                type="button"
                aria-pressed={settingsTab === 'preferences'}
                onClick={() => setSettingsTab('preferences')}
              >
                偏好记忆
              </button>
            </nav>
            {settingsTab === 'models'
              ? <ModelSettings api={api} />
              : <PreferenceSettings api={api} />}
          </section>
        </div>
      )}
    </main>
  );
}
