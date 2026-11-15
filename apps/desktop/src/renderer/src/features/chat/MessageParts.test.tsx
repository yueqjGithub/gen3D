// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MessageParts } from './MessageParts';
import { api } from '../../api/client';

describe('native message rendering', () => {
  it('shows a pending response instead of an empty message bubble', () => {
    const { getByRole } = render(<MessageParts pending message={{ id: 'pending', role: 'assistant', parts: [{ type: 'text', text: '' }] }} />);
    expect(getByRole('status').textContent).toContain('正在生成');
  });
  it('renders an unfinished streaming code fence as code', () => {
    const { container } = render(<MessageParts message={{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: '\x60\x60\x60python\nimport bpy' }] }} />);
    expect(container.querySelector('code')?.textContent?.trim()).toBe('import bpy');
  });
  it('uses credentials for Markdown images only on the configured API origin', () => {
    const { protocol, hostname } = new URL(api.baseUrl);
    const text = [
      `![附件](${api.baseUrl}/api/images/1)`,
      `![外部图片](${protocol}//${hostname}.example.org/image.png)`,
    ].join('\n\n');
    const { getByAltText } = render(<MessageParts message={{
      id: 'images', role: 'assistant', parts: [{ type: 'text', text }],
    }} />);
    expect(getByAltText('附件').getAttribute('crossorigin')).toBe('use-credentials');
    expect(getByAltText('外部图片').hasAttribute('crossorigin')).toBe(false);
  });
  it('renders images and native tool input and output', () => {
    render(<MessageParts message={{ id: 'b', role: 'assistant', parts: [
      { type: 'file', mediaType: 'image/png', url: 'https://example.com/image.png', filename: 'reference' },
      { type: 'dynamic-tool', toolName: 'generate-blender-script', toolCallId: 'tool', state: 'output-available', input: { script: 'import bpy' }, output: { validation: 'passed' } },
    ] }} />);
    expect(screen.getByAltText('reference').getAttribute('src')).toBe('https://example.com/image.png');
    expect(screen.getByText(/generate-blender-script/)).toBeDefined();
    expect(screen.getByText(/passed/)).toBeDefined();
  });
});


