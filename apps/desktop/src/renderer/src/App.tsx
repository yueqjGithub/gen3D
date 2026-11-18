import { useEffect, useRef, useState } from 'react';
import type { AssetArtifact, Conversation } from '@agent3d/shared';
import { api } from './api/client';
import type { ChatUIMessage } from './api/types';
import { AssetPanel } from './features/assets/AssetPanel';
import { ChatView } from './features/chat/ChatView';
import { ConversationSidebar } from './features/conversations/ConversationSidebar';
import { ModelSettings } from './features/settings/ModelSettings';
import { ModelProvider } from './features/settings/ModelContext';
import { PreferenceSettings } from './features/settings/PreferenceSettings';
import { LoginForm } from './features/login/LoginForm';
import { LocalApiError } from './api/client';
import { AccountMenu } from './features/login/AccountMenu';
import { MyAssets } from './features/assets/MyAssets';

/** 工作台的顶层状态：当前会话、历史消息、当前资产和设置面板。 */
export default function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [checkingLogin, setCheckingLogin] = useState(true);
  const [changingPassword, setChangingPassword] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  const [artifact, setArtifact] = useState<AssetArtifact | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'models' | 'preferences'>('models');
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initRef = useRef(false);

  // 启动时先检查 Cookie；网络错误与未登录分开显示。
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      void api.currentUser().then((user) => {
        setUsername(user);
      }).catch((loginError: unknown) => {
        if (!(loginError instanceof LocalApiError && loginError.status === 401)) {
          setError(loginError instanceof Error ? loginError.message : '无法连接服务。');
        }
      }).finally(() => { setCheckingLogin(false); });
    }
  }, []);

  // 登录后再读取会话列表，避免在用户名还未确定时发起请求。
  useEffect(() => {
    if (!username) return;
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
  }, [username]);

  const activeConversation = conversations.find(({ id }) => id === activeConversationId) ?? null;

  // 切换会话时重新加载历史消息，并从历史中找到最近生成的资产。
  useEffect(() => {
    if (!activeConversation) {
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
  }, [activeConversation?.id]);

  async function createConversation() {
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
    const updated = await api.renameConversation(id, title);
    setConversations((current) => current.map((conversation) =>
      conversation.id === id ? updated : conversation));
  }

  async function deleteConversation(id: string) {
    await api.deleteConversation(id);
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setConversations(remaining);
    if (activeConversationId === id) {
      setActiveConversationId(remaining[0]?.id ?? null);
    }
  }

  async function openAsset(artifactId: string) {
    try {
      const details = await api.getArtifact(artifactId);
      setArtifact(details.artifact);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取资产。');
    }
  }

  if (checkingLogin) return <main className="login-screen">正在检查登录状态…</main>;
  if (!username) return (
    <main className="login-screen">
      {error && <p role="alert">{error}</p>}
      <LoginForm onLogin={(user) => { setError(null); setUsername(user); }} />
    </main>
  );

  return (
    <ModelProvider>
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
          <AccountMenu username={username} onAssets={() => setAssetsOpen(true)}
            onPassword={() => setChangingPassword(true)} onSettings={() => setSettingsOpen(true)} />
        </div>

        {error && <p className="workspace__error" role="alert">{error}</p>}
        {loadingConversations ? (
          <p className="workspace__loading" role="status">正在读取会话…</p>
        ) : activeConversation ? (
          <div className="workspace__content">
            <div className="workspace__chat">
              {loadingMessages ? (
                <p className="workspace__loading" role="status">正在读取对话…</p>
              ) : (
                <ChatView
                  key={activeConversation.id}
                  conversation={activeConversation}
                  initialMessages={messages}
                  onArtifactChange={setArtifact}
                  onOpenAsset={(artifactId) => void openAsset(artifactId)}
                  onOpenModelSettings={() => { setSettingsTab('models'); setSettingsOpen(true); }}
                />
              )}
            </div>
            {artifact && (
              <AssetPanel
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
            <small>会话与资产自动保存，随时继续创作。</small>
          </section>
        )}
      </section>

      {assetsOpen && <MyAssets onClose={() => setAssetsOpen(false)} />}
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
              ? <ModelSettings />
              : <PreferenceSettings />}
          </section>
        </div>
      )}
      {changingPassword && (
        <div className="settings-overlay">
          <LoginForm username={username} onClose={() => setChangingPassword(false)} />
        </div>
      )}
    </main>
    </ModelProvider>
  );
}
