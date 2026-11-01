import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createDatabase } from '../storage/database';
import { createPreferenceRepository } from '../storage/preferences';
import { uploadMetadataSchema } from '@agent3d/shared';
import {
  extractDocument,
} from './extract-document';
import { createAssetAgent } from './asset-agent';
import { createMastra } from './mastra';
import { createMastraModel } from './model-adapter';
import {
  prepareConversationInput,
  toInlineImageDataUrl,
  UnsupportedInlineImageError,
} from './tools/analyze-input';
import { parseAgentOutput } from './tools/generate-blender-script';
import { persistPreferenceProposal } from './tools/update-preferences';
import { validateBlenderScript } from './validate-script';
import { assetAgentInstructions } from './prompts/asset-agent';

function createPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 30 80 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ];

  let document = '%PDF-1.4\n';
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(document, 'binary');
    document += `${object}\n`;
    return offset;
  });
  const xrefOffset = Buffer.byteLength(document, 'binary');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(document, 'binary'));
}

describe('agent inputs', () => {
  it('extractsTextMarkdownAndPdfDocuments', async () => {
    await expect(extractDocument({
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('  A carved stone vessel.  '),
    })).resolves.toEqual({ text: 'A carved stone vessel.' });

    await expect(extractDocument({
      mediaType: 'text/markdown',
      bytes: new TextEncoder().encode('# Shape\n\nA round clay bowl.'),
    })).resolves.toEqual({ text: '# Shape\n\nA round clay bowl.' });

    const extractedPdf = await extractDocument({
      mediaType: 'application/pdf',
      bytes: createPdf('A bronze leaf pendant.'),
    });
    expect(extractedPdf.text).toContain('A bronze leaf pendant.');
  });

  it('rejectsMalformedPdfDocuments', async () => {
    await expect(extractDocument({
      mediaType: 'application/pdf',
      bytes: new TextEncoder().encode('not a PDF'),
    })).rejects.toThrow();
  });

  it('rejectsDocumentTextThatExceedsTheAgentContextLimit', async () => {
    await expect(extractDocument({
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('x'.repeat(100_001)),
    })).rejects.toThrow('exceeds 100000 characters');
  });

  it('convertsLocalImageBytesToAnInlineDataUrl', () => {
    expect(toInlineImageDataUrl('image/png', new Uint8Array([1, 2, 3])))
      .toBe('data:image/png;base64,AQID');
    expect(() => toInlineImageDataUrl('application/pdf', new Uint8Array([1])))
      .toThrow();
  });

  it('preparesOnlyAttachmentsOwnedByTheConversation', async () => {
    const conversationId = randomUUID();
    const attachment = uploadMetadataSchema.parse({
      id: randomUUID(),
      conversationId,
      fileName: 'reference.png',
      mediaType: 'image/png',
      size: 3,
      kind: 'image',
      createdAt: new Date().toISOString(),
    });
    const attachments = {
      save: async () => attachment,
      read: async (id: string) => id === attachment.id ? new Uint8Array([1, 2, 3]) : null,
      listByConversation: (id: string) => id === conversationId ? [attachment] : [],
      deleteByConversation: async () => undefined,
    };

    await expect(prepareConversationInput(
      attachments,
      conversationId,
      [attachment.id],
      true,
    ))
      .resolves.toMatchObject({
        images: [{
          fileName: 'reference.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,AQID',
        }],
      });
    await expect(prepareConversationInput(
      attachments,
      randomUUID(),
      [attachment.id],
      true,
    ))
      .rejects.toThrow('does not belong');
    await expect(prepareConversationInput(
      attachments,
      conversationId,
      [attachment.id],
      false,
    )).rejects.toBeInstanceOf(UnsupportedInlineImageError);
  });
});

describe('Mastra asset agent', () => {
  it('generatesAValidatedStructuredAssetResultWithAFakeModel', async () => {
    const agent = createAssetAgent({
      model: createMockModel({
        mockText: {
          result: {
            type: 'asset',
            brief: 'A shallow ceramic bowl with a hand-cut rim.',
            script: 'import bpy\nbpy.ops.mesh.primitive_uv_sphere_add()',
            blenderVersion: '4.x',
            preferenceProposals: [],
          },
        },
        objectGenerationMode: 'json',
        version: 'v2',
      }),
      preferences: {
        list: () => ({}),
        upsert: () => undefined,
        delete: () => false,
      },
      attachments: {
        save: async () => {
          throw new Error('Not used in this test.');
        },
        read: async () => null,
        listByConversation: () => [],
        deleteByConversation: async () => undefined,
      },
      supportsInlineImages: true,
    });

    const result = await agent.generate('Create a small ceramic bowl.');
    expect(result.object.result).toMatchObject({
      type: 'asset',
      brief: 'A shallow ceramic bowl with a hand-cut rim.',
      blenderVersion: '4.x',
    });
  });

  it('routesNonCreationAndAmbiguousIntentToChat', () => {
    expect(assetAgentInstructions).toContain('Use result.type "chat" for greetings');
    expect(assetAgentInstructions).toContain('Only use result.type "asset" when the user explicitly asks to create');
    expect(assetAgentInstructions).toContain('If the user only attaches an image or document, use result.type "chat" and ask whether they want an asset created');
  });

  it('createsAnAnthropicModelWithoutGlobalCredentialState', () => {
    expect(() => createMastraModel({
      providerId: 'anthropic',
      modelId: 'anthropic/claude-sonnet-4-5',
      baseURL: 'https://models.example.test/v1',
      protocol: 'anthropic',
      supportsInlineImages: true,
      apiKey: 'test-only-key',
    })).not.toThrow();
  });

  it('createsAnAgentWithAStaticValidationTool', async () => {
    const mastra = createMastra({
      model: createMastraModel({
        providerId: 'agnes',
        modelId: 'agnes/agnes-3.0-flash',
        baseURL: 'https://models.example.test/v1',
        protocol: 'openai-compatible',
        supportsInlineImages: true,
        apiKey: 'test-only-key',
      }),
      preferences: {
        list: () => ({}),
        upsert: () => undefined,
        delete: () => false,
      },
      attachments: {
        save: async () => {
          throw new Error('Not used in this test.');
        },
        read: async () => null,
        listByConversation: () => [],
        deleteByConversation: async () => undefined,
      },
      supportsInlineImages: true,
    });

    const agent = mastra.getAgent('assetAgent');
    expect(agent.id).toBe('asset-creation-agent');
    const tools = await agent.getToolsForExecution({});
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      'analyzeInput',
      'buildAssetBrief',
      'validateBlenderScript',
      'proposePreferenceUpdate',
    ]));
  });
});

describe('Blender script output', () => {
  it('returnsStructuredBlender4AssetResult', () => {
    expect(parseAgentOutput({
      type: 'asset',
      brief: 'A small faceted stone sculpture.',
      script: 'import bpy\nbpy.ops.mesh.primitive_ico_sphere_add()',
      blenderVersion: '4.x',
      preferenceProposals: [],
    })).toMatchObject({
      type: 'asset',
      blenderVersion: '4.x',
      brief: 'A small faceted stone sculpture.',
    });
  });

  it('rejectsEmptyOrOversizedScripts', () => {
    expect(validateBlenderScript('')).toEqual({ ok: false, code: 'empty' });
    expect(validateBlenderScript(`import bpy\n${'x'.repeat(100 * 1024)}`))
      .toEqual({ ok: false, code: 'too_large' });
    expect(validateBlenderScript('print("not a Blender script")'))
      .toEqual({ ok: false, code: 'missing_bpy' });
  });

  it('blocksDangerousExecutionPatterns', () => {
    for (const script of [
      'import bpy\nexec("print(1)")',
      'import bpy\neval("1 + 1")',
      'import bpy\nimport subprocess',
      'import bpy\nos.system("whoami")',
    ]) {
      expect(validateBlenderScript(script)).toEqual({
        ok: false,
        code: 'blocked_pattern',
      });
    }
  });

  it('doesNotExecuteGeneratedScript', () => {
    const sentinel = join(tmpdir(), `agent3d-script-${randomUUID()}.txt`);
    const output = parseAgentOutput({
      type: 'asset',
      brief: 'A simple test asset.',
      script: `import bpy\nopen(${JSON.stringify(sentinel)}, "w").write("executed")`,
      blenderVersion: '4.x',
      preferenceProposals: [],
    });

    expect(output.script).toContain('open(');
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe('preference proposals', () => {
  it('persistsOnlyConfirmedPreferenceProposals', async () => {
    const database = createDatabase(':memory:');
    const preferences = createPreferenceRepository(database.connection);
    const proposal = {
      key: 'visualStyle',
      value: 'faceted',
      reason: 'The user chose faceted forms in multiple sessions.',
    };

    try {
      await persistPreferenceProposal(preferences, proposal, false);
      expect(preferences.list()).toEqual({});

      await persistPreferenceProposal(preferences, proposal, true);
      expect(preferences.list()).toEqual({ visualStyle: 'faceted' });
    } finally {
      database.close();
    }
  });
});
