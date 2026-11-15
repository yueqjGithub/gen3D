// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import type { UploadMetadata } from '@agent3d/shared';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ready = {
  generating: false, modelId: 'test-model', hasApiKey: true,
  onOpenModelSettings: vi.fn(), onStop: vi.fn(),
};

it('shows the selected model and blocks sending until its API key is configured', () => {
  const openSettings = vi.fn();
  render(<Composer
    onUpload={vi.fn()}
    onSubmit={vi.fn()}
    generating={false}
    onStop={vi.fn()}
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
    generating={false}
    onStop={vi.fn()}
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

it('queues dropped documents and pasted screenshots in order and sends their attachment IDs', async () => {
  const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => 'blob:preview';
    static revokeObjectURL = revoke;
  });
  const document = new File(['brief'], 'brief.md'); // Windows 可能只提供扩展名。
  const screenshot = new File(['pixels'], 'image.png', { type: 'image/png' });
  let finishUpload!: () => void;
  const uploading = new Promise<void>(resolve => { finishUpload = resolve; });
  const onUpload = vi.fn(async (file: File): Promise<UploadMetadata> => {
    await uploading;
    const image = file.type === 'image/png';
    return {
      id: file.name, fileName: file.name, conversationId: 'conversation',
      size: file.size, mediaType: image ? 'image/png' : 'text/markdown',
      kind: image ? 'image' : 'document', createdAt: new Date().toISOString(),
    };
  });
  const onSubmit = vi.fn();
  render(<Composer {...ready} onUpload={onUpload} onSubmit={onSubmit} />);
  const prompt = screen.getByRole('textbox');
  const transfer = { types: ['Files'], files: [document] };
  expect(fireEvent.dragOver(prompt, { dataTransfer: transfer })).toBe(false);
  expect(fireEvent.drop(prompt, { dataTransfer: transfer })).toBe(false);
  const item = { kind: 'file', getAsFile: () => screenshot };
  expect(fireEvent.paste(prompt, { clipboardData: { files: [], items: [item] } })).toBe(false);
  expect(screen.getByAltText('image.png').getAttribute('src')).toBe('blob:preview');
  fireEvent.click(screen.getByRole('button', { name: '移除 image.png' }));
  expect(screen.queryByAltText('image.png')).toBeNull();
  expect(revoke).toHaveBeenCalledWith('blob:preview');
  expect(onUpload).not.toHaveBeenCalled();
  fireEvent.paste(prompt, { clipboardData: { files: [], items: [item] } });
  const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
  fireEvent.click(send);
  expect(onUpload).toHaveBeenCalledTimes(1);
  expect(onUpload.mock.calls[0]?.[0].type).toBe('text/markdown');
  expect(send.disabled).toBe(true);
  finishUpload();
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(onUpload.mock.calls[1]?.[0]).toBe(screenshot);
  expect(onSubmit.mock.calls[0]?.[1].map((file: UploadMetadata) => file.id)).toEqual(['brief.md', 'image.png']);
});

it('preserves ordinary text paste and rejects unsupported files from the clipboard', async () => {
  const onUpload = vi.fn();
  render(<Composer {...ready} onUpload={onUpload} onSubmit={vi.fn()} />);
  const prompt = screen.getByRole('textbox');
  expect(fireEvent.paste(prompt, { clipboardData: { files: [], items: [{ kind: 'string' }] } })).toBe(true);
  const bad = new File(['bad'], 'archive.zip', { type: 'application/zip' });
  expect(fireEvent.paste(prompt, { clipboardData: { files: [bad], items: [] } })).toBe(false);
  expect((await screen.findByRole('alert')).textContent).toContain('archive.zip');
  expect(onUpload).not.toHaveBeenCalled();
});

it('switches the same send button to stop and back without submitting a second message', () => {
  const props = { ...ready, onUpload: vi.fn(), onStop: vi.fn(), onSubmit: vi.fn() };
  const { rerender } = render(<Composer {...props} />);
  const button = screen.getByRole('button', { name: '发送' });
  rerender(<Composer {...props} generating />);
  expect(screen.getByRole('button', { name: '停止生成' })).toBe(button);
  fireEvent.click(button);
  expect(props.onStop).toHaveBeenCalledOnce();
  expect(props.onSubmit).not.toHaveBeenCalled();
  rerender(<Composer {...props} />);
  expect(screen.getByRole('button', { name: '发送' })).toBe(button);
});
