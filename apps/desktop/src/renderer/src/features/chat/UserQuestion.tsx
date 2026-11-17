import { useId, useState, type FormEvent } from 'react';
import type { UserQuestion as Question } from '@agent3d/shared';

/** 每张提问卡片自己保存选项与草稿，提交失败时保留输入，成功后显示已选答案。 */
export function UserQuestion({ question, active, answered, onAnswer }: {
  question: Question;
  active: boolean;
  answered?: string;
  onAnswer(answer: string): Promise<void>;
}) {
  const [selected, setSelected] = useState<number | 'custom'>();
  const group = useId();
  const [custom, setCustom] = useState('');
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState('');
  const answer = selected === 'custom' ? custom.trim() : question.options[selected ?? -1]?.label ?? '';
  const result = answered || submitted;
  // submitted 是当前页面提交成功后的即时反馈。
  // answered 来自恢复后 ask-user 的工具输出，用于重新加载历史时还原答案。

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!active || sending || result || !answer) return;
    setSending(true);
    setError('');
    try {
      // onAnswer 经 ChatView 调用 api.answerQuestion，发送 POST /api/chat/answer。
      // 这个短请求回 204 后就结束。继续生成的结果会从原来的聊天 SSE 返回，
      // 本组件只负责把按钮锁定并显示答案，后续文本展示仍由 useChat 驱动。
      await onAnswer(answer);
      setSubmitted(answer);
    } catch (error) {
      setError(error instanceof Error ? error.message : '提交失败，请重试。');
    } finally {
      setSending(false);
    }
  }

  return <form className="user-question" onSubmit={event => void submit(event)}>
    <fieldset disabled={!active || sending || Boolean(result)}>
      <legend>{question.question}</legend>
      {question.options.map((option, index) => <label className="user-question__option" key={index}>
        <input type="radio" name={group} checked={selected === index} onChange={() => setSelected(index)} />
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}
      <label className="user-question__option">
        <input type="radio" name={group} checked={selected === 'custom'} onChange={() => setSelected('custom')} />
        <span>自定义</span>
      </label>
      <textarea aria-label="自定义答案" maxLength={2000} rows={2} value={custom}
        placeholder="也可以写下你的想法…"
        onFocus={() => setSelected('custom')}
        onChange={event => { setSelected('custom'); setCustom(event.target.value); }} />
      <button type="submit" disabled={!answer}>{sending ? '正在提交…' : '提交并继续'}</button>
    </fieldset>
    {result && <p>已回答：{result}</p>}
    {!active && !result && <p>本次提问已结束，请在输入框中继续对话。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>;
}
