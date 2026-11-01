import { useState, type FormEvent } from 'react';
import type { Conversation } from '@agent3d/shared';

export interface ConversationSidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  onRename(id: string, title: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export function ConversationSidebar({
  conversations,
  activeConversationId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: ConversationSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submitRename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    try {
      await onRename(id, titleDraft);
      setEditingId(null);
      setError(null);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : '无法重命名会话。');
    }
  }

  async function deleteConversation(id: string) {
    try {
      await onDelete(id);
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '无法删除会话。');
    }
  }

  return (
    <aside className="conversation-sidebar" aria-label="会话列表">
      <header className="conversation-sidebar__header">
        <div>
          <span className="conversation-sidebar__eyebrow">AGENT WORKSHOP</span>
          <h1>形构</h1>
        </div>
        <button type="button" className="icon-button" aria-label="新建会话" onClick={onCreate}>
          +
        </button>
      </header>

      <button type="button" className="conversation-sidebar__new" onClick={onCreate}>
        <span aria-hidden="true">＋</span> 新建创作
      </button>

      <h2 className="conversation-sidebar__section-title">最近会话</h2>
      <ul className="conversation-sidebar__list">
        {conversations.map((conversation) => (
          <li
            className={conversation.id === activeConversationId
              ? 'conversation-sidebar__item is-active'
              : 'conversation-sidebar__item'}
            key={conversation.id}
          >
            {editingId === conversation.id ? (
              <form onSubmit={(event) => void submitRename(event, conversation.id)}>
                <label className="visually-hidden" htmlFor={`rename-${conversation.id}`}>
                  重命名会话
                </label>
                <input
                  autoFocus
                  id={`rename-${conversation.id}`}
                  maxLength={120}
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditingId(null);
                    }
                  }}
                />
                <button type="submit" aria-label="保存会话名称">保存</button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="conversation-sidebar__select"
                  aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className="conversation-sidebar__conversation-title">{conversation.title}</span>
                  <time dateTime={conversation.updatedAt}>
                    {new Date(conversation.updatedAt).toLocaleDateString('zh-CN')}
                  </time>
                </button>
                <div className="conversation-sidebar__actions">
                  <button
                    type="button"
                    aria-label={`重命名 ${conversation.title}`}
                    onClick={() => {
                      setTitleDraft(conversation.title);
                      setEditingId(conversation.id);
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    aria-label={`删除 ${conversation.title}`}
                    onClick={() => void deleteConversation(conversation.id)}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="inline-error" role="alert">{error}</p>}

      <footer className="conversation-sidebar__footer">
        <span className="status-dot" aria-hidden="true" />
        本地保存 · 仅此设备可见
      </footer>
    </aside>
  );
}
