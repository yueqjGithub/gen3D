// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UserQuestion } from './UserQuestion';

afterEach(cleanup);
const question = { question: '选择花瓶材质', options: [
  { label: '陶瓷', description: '柔和釉面' }, { label: '金属', description: '金属反光' },
] };

it('submits the selected option once and disables the completed question', async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<UserQuestion question={question} active onAnswer={onAnswer} />);
  const button = screen.getByRole('button', { name: '提交并继续' }) as HTMLButtonElement;
  expect(button.matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /陶瓷/ }));
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText('已回答：陶瓷')).toBeTruthy());
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('陶瓷');
  expect(button.matches(':disabled')).toBe(true);
});

it('preserves custom text on failure and allows retry', async () => {
  const onAnswer = vi.fn().mockRejectedValueOnce(new Error('连接失败')).mockResolvedValue(undefined);
  render(<UserQuestion question={question} active onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole('textbox', { name: '自定义答案' }), { target: { value: ' 青绿釉面 ' } });
  fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
  expect((await screen.findByRole('alert')).textContent).toBe('连接失败');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(' 青绿釉面 ');
  fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
  await screen.findByText('已回答：青绿釉面');
  expect(onAnswer).toHaveBeenLastCalledWith('青绿釉面');
});
