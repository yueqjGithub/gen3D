import { describe, expect, it } from 'vitest';
import { adaptAgentChunk } from './agent-ui-stream';

describe('Agent UI stream adapter', () => {
  it('mapsTextAndReasoningToRendererChunksAndHistory', () => {
    const text = adaptAgentChunk({ type: 'text-delta', id: 'text-1', delta: 'Hello.' });
    const reasoning = adaptAgentChunk({
      type: 'reasoning-delta',
      id: 'reasoning-1',
      delta: 'Checking the design context.',
    });

    expect(text).toEqual({
      uiChunk: { type: 'text-delta', id: 'text-1', delta: 'Hello.' },
      persistedPart: null,
      textDelta: 'Hello.',
    });
    expect(reasoning).toEqual({
      uiChunk: { type: 'reasoning-delta', id: 'reasoning-1', delta: 'Checking the design context.' },
      persistedPart: { type: 'reasoning', text: 'Checking the design context.' },
    });
  });

  it('forwardsOnlySanitizedActivityForKnownTools', () => {
    const knownTools = new Map<string, string>();
    const input = adaptAgentChunk({
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'analyze-input',
      input: { fileName: 'reference.png', apiKey: 'never-forward-this' },
    }, knownTools);
    const output = adaptAgentChunk({
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: { extractedText: 'never-forward-this-either' },
    }, knownTools);

    expect(input.uiChunk).toEqual({
      type: 'data-activity',
      id: 'call-1',
      data: { toolCallId: 'call-1', toolName: 'analyze-input', state: 'input-available' },
    });
    expect(output.uiChunk).toEqual({
      type: 'data-activity',
      id: 'call-1',
      data: { toolCallId: 'call-1', toolName: 'analyze-input', state: 'output-available' },
    });
    expect(JSON.stringify([input, output])).not.toContain('never-forward-this');
    expect(JSON.stringify([input, output])).not.toContain('reference.png');
  });

  it('ignoresUnknownToolsAndStructuredOutputData', () => {
    const knownTools = new Map<string, string>();

    expect(adaptAgentChunk({
      type: 'tool-input-start',
      toolCallId: 'call-2',
      toolName: 'unregistered-tool',
    }, knownTools)).toEqual({ uiChunk: null, persistedPart: null });
    expect(adaptAgentChunk({
      type: 'data-structured-output',
      data: { object: { result: { type: 'chat', reply: 'Hello.' } } },
    }, knownTools)).toEqual({ uiChunk: null, persistedPart: null });
  });
});
