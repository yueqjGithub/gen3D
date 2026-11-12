// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

afterEach(cleanup);

it('shows the selected model and blocks sending until its API key is configured', () => {
  const openSettings = vi.fn();
  render(<Composer
    onUpload={vi.fn()}
    onSubmit={vi.fn()}
    disabled={false}
    modelId="agnes/agnes-3.0-flash"
    hasApiKey={false}
    onOpenModelSettings={openSettings}
  />);
  fireEvent.change(screen.getByLabelText('写下你的想法'), { target: { value: '你好' } });
  expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('请在模型设置中填写 API Key')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /agnes\/agnes-3.0-flash/ }));
  expect(openSettings).toHaveBeenCalledOnce();
});

it('allows sending once the selected model has an API key', () => {
  const submit = vi.fn();
  render(<Composer
    onUpload={vi.fn()}
    onSubmit={submit}
    disabled={false}
    modelId="openai/gpt-4.1-mini"
    hasApiKey
    onOpenModelSettings={vi.fn()}
  />);
  fireEvent.change(screen.getByLabelText('写下你的想法'), { target: { value: '你好' } });
  const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  expect(submit).toHaveBeenCalledWith('你好', []);
});
