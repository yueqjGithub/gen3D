import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { PreferenceRepository } from '../../storage/preferences';
import { MAX_EXTRACTED_DOCUMENT_CHARACTERS } from '../extract-document';

const maxBriefCharacters = MAX_EXTRACTED_DOCUMENT_CHARACTERS;

const briefInputSchema = z.object({
  request: z.string().trim().min(1).max(8000),
  documentTexts: z.array(z.string().max(maxBriefCharacters)).max(20),
}).superRefine(({ request, documentTexts }, context) => {
  const sourceCharacters = request.length + documentTexts.reduce((total, text) => total + text.length, 0);
  if (sourceCharacters > maxBriefCharacters) {
    context.addIssue({
      code: 'custom',
      message: `Asset context exceeds the ${maxBriefCharacters}-character limit.`,
    });
  }
});

export function createBuildAssetBriefTool(preferences: PreferenceRepository) {
  return createTool({
    id: 'build-asset-brief',
    description: 'Combine the user request, extracted document text, and saved style preferences into an asset brief.',
    inputSchema: briefInputSchema,
    outputSchema: z.object({ brief: z.string().min(1).max(maxBriefCharacters) }),
    execute: async ({ request, documentTexts }) => {
      const savedPreferences = preferences.list();
      const sections = [
        `User request:\n${request}`,
        ...(documentTexts.length > 0
          ? [`Attached document context:\n${documentTexts.map((text, index) => `Document ${index + 1}:\n${text}`).join('\n\n')}`]
          : []),
        ...(Object.keys(savedPreferences).length > 0
          ? [`User preferences:\n${Object.entries(savedPreferences).map(([key, value]) => `- ${key}: ${value}`).join('\n')}`]
          : []),
      ];
      const brief = sections.join('\n\n');
      if (brief.length > maxBriefCharacters) {
        throw new RangeError(`Asset brief exceeds the ${maxBriefCharacters}-character limit.`);
      }
      return { brief };
    },
  });
}
