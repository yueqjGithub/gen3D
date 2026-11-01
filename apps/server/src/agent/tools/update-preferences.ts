import { createTool } from '@mastra/core/tools';
import {
  preferenceProposalSchema,
  type PreferenceProposal,
} from '@agent3d/shared';
import { z } from 'zod';
import type { PreferenceRepository } from '../../storage/preferences';

// The agent can suggest preferences, but only an explicit user confirmation persists one.
export function persistPreferenceProposal(
  preferences: Pick<PreferenceRepository, 'upsert'>,
  proposal: PreferenceProposal,
  confirmed: boolean,
): boolean {
  const validProposal = preferenceProposalSchema.parse(proposal);
  if (!confirmed) {
    return false;
  }
  preferences.upsert(validProposal.key, validProposal.value);
  return true;
}

export function createPreferenceProposalTool(preferences: PreferenceRepository) {
  return createTool({
    id: 'propose-preference-update',
    description: 'Suggest a durable preference for user review without saving it.',
    inputSchema: preferenceProposalSchema,
    outputSchema: z.object({
      proposal: preferenceProposalSchema,
      currentValue: z.string().nullable(),
    }),
    execute: async (proposal) => ({
      proposal,
      currentValue: preferences.list()[proposal.key] ?? null,
    }),
  });
}
