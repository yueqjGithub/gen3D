import { useState } from 'react';
import type { PreferenceProposal } from '@agent3d/shared';
import type { ChatUIMessage } from '../../api/types';

export interface MessagePartsProps {
  message: ChatUIMessage;
  onOpenAsset?(artifactId: string): void;
  onConfirmPreference?(proposal: PreferenceProposal): Promise<void> | void;
}

/** 按消息 part 的类型渲染文本、推理、工具活动、附件、资产和偏好建议。 */
export function MessageParts({
  message,
  onOpenAsset,
  onConfirmPreference,
}: MessagePartsProps) {
  const [proposalError, setProposalError] = useState<string | null>(null);

  // 偏好建议必须由用户点击确认后才保存；失败时保留提示供用户重试。
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
          // 按代码围栏拆分，React 自动转义文本，避免执行模型输出的 HTML。
          return <div className="message-parts__text" key={index}>{part.text.split(/(```[\s\S]*?```|!\[[^\]]*\]\([^)]+\))/g).map((block, i) => {
            if (block.startsWith('```')) return <pre key={i}><code>{block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code></pre>;
            const image = /^!\[([^\]]*)\]\((https?:\/\/[^)]+|data:image\/[^)]+)\)$/.exec(block);
            return image ? <img key={i} src={image[2]} alt={image[1]} style={{maxWidth: '100%'}} /> : <span key={i}>{block}</span>;
          })}</div>;
        }
        // useChat 已经把原生工具事件合并为一个带 state 的工具 part。
        if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
          const tool = part as { type: string; toolName?: string; state?: string; input?: unknown; output?: unknown; errorText?: string };
          return <details key={index}><summary>{tool.toolName ?? tool.type.slice(5)} · {tool.state}</summary><pre>{JSON.stringify(tool.input, null, 2)}</pre><pre>{tool.errorText ?? JSON.stringify(tool.output, null, 2)}</pre></details>;
        }
        if (part.type === 'file') {
          return part.mediaType.startsWith('image/') ? <img key={index} src={part.url} alt={part.filename ?? '图片'} style={{maxWidth: '100%'}} /> : <a key={index} href={part.url}>{part.filename ?? '附件'}</a>;
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
