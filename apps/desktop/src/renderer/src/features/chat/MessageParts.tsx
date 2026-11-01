import { useState } from 'react';
import type { PreferenceProposal } from '@agent3d/shared';
import type { ChatUIMessage } from '../../api/types';

export interface MessagePartsProps {
  message: ChatUIMessage;
  onOpenAsset?(artifactId: string): void;
  onConfirmPreference?(proposal: PreferenceProposal): Promise<void> | void;
}

export function MessageParts({
  message,
  onOpenAsset,
  onConfirmPreference,
}: MessagePartsProps) {
  const [proposalError, setProposalError] = useState<string | null>(null);

  async function confirm(proposal: PreferenceProposal) {
    if (!onConfirmPreference) {
      return;
    }
    try {
      await onConfirmPreference(proposal);
      setProposalError(null);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '偏好保存失败。');
    }
  }

  return (
    <div className={`message-parts message-parts--${message.role}`}>
      {message.metadata?.persistedStatus === 'error' && (
        <p className="message-parts__failure" role="status">上次生成未完成，可重试。</p>
      )}
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          return <p className="message-parts__text" key={`text-${index}`}>{part.text}</p>;
        }
        if (part.type === 'reasoning') {
          return (
            <details className="message-parts__reasoning" key={`reasoning-${index}`}>
              <summary>推理过程</summary>
              <p>{part.text}</p>
            </details>
          );
        }
        if (part.type === 'data-activity') {
          const activity = part.data;
          const stateLabel = {
            'input-streaming': '正在准备',
            'input-available': '已调用',
            'output-available': '已完成',
            error: '执行失败',
          }[activity.state];
          return (
            <div className="message-parts__activity" key={part.id ?? `activity-${index}`}>
              <span className="activity-indicator" aria-hidden="true" />
              <span>{activity.toolName}</span>
              <span>{stateLabel}</span>
            </div>
          );
        }
        if (part.type === 'data-attachment') {
          return (
            <div className="message-parts__attachment" key={part.id ?? `attachment-${index}`}>
              <span aria-hidden="true">▧</span>
              <span>{part.data.fileName}</span>
              <small>{part.data.mediaType}</small>
            </div>
          );
        }
        if (part.type === 'data-asset') {
          return (
            <article className="message-parts__asset" key={part.id ?? `asset-${index}`}>
              <div>
                <span className="message-parts__asset-label">BLENDER {part.data.blenderVersion}</span>
                <h3>{part.data.brief}</h3>
                <p>{part.data.status === 'pending' ? '等待审阅' : part.data.status === 'approved' ? '已批准' : '已拒绝'}</p>
              </div>
              <button
                type="button"
                onClick={() => onOpenAsset?.(part.data.id)}
                aria-label={`审阅资产：${part.data.brief}`}
              >
                审阅资产
              </button>
            </article>
          );
        }
        if (part.type === 'data-preference') {
          const proposal = part.data;
          return (
            <aside className="message-parts__proposal" key={`proposal-${index}`}>
              <div>
                <strong>偏好建议：{proposal.key}</strong>
                <p>{proposal.value}</p>
                <small>{proposal.reason}</small>
              </div>
              <button
                type="button"
                onClick={() => void confirm(proposal)}
                disabled={!onConfirmPreference}
                aria-label={`保存偏好：${proposal.key}`}
              >
                确认保存
              </button>
            </aside>
          );
        }
        return null;
      })}
      {proposalError && <p className="inline-error" role="alert">{proposalError}</p>}
    </div>
  );
}
