# Explicit Asset Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep ordinary chat conversational and create a 3D asset only when the user explicitly requests one.

**Architecture:** Extend the shared Agent output into a discriminated `chat` or `asset` result. Update Agent instructions to select the chat variant for greetings, general questions, ambiguous requests, and attachment-only turns; the chat route persists assistant text for either result but creates/emits an artifact only for the asset variant.

**Tech Stack:** TypeScript, Zod, Mastra, Hono, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-01-explicit-asset-generation-design.md`

## Global Constraints

- Generate and persist a Blender asset only for clear creation requests.
- When a user sends only an image or document, ask whether they want an asset created from it.
- Do not convert an attachment-only message into a synthetic instruction to create an asset.
- Keep the existing review-before-approval workflow for generated scripts.
- Do not add a separate conversational model or deterministic keyword classifier.
- Only the asset variant contains a Blender script and preference proposals.
- The chat route creates an artifact and emits asset data only for the asset variant.

## Review Focus

- A greeting such as “你好” must persist a conversational answer without creating an artifact.
- A general 3D-related question must not be interpreted as a creation request.
- Ambiguous intent must be met with a clarification and no artifact.
- An image/document-only turn must ask whether the user wants generation and create no artifact yet.
- An image-only turn must reach the Agent as neutral reference context, not as an implicit creation command.
- A clear asset-generation request must still produce a validated pending artifact.

---

### Task 1: Add explicit chat and asset Agent output variants

**Files:**
- Modify: `packages/shared/src/agent.ts`
- Test: `packages/shared/src/contracts.test.ts`
- Modify: `apps/server/src/agent/prompts/asset-agent.ts`
- Modify: `apps/server/src/agent/asset-agent.ts`
- Modify: `apps/server/src/agent/tools/generate-blender-script.ts`
- Modify: `apps/server/src/testing/mock-model.ts`
- Test: `apps/server/src/agent/agent.test.ts`

**Interfaces:**
- Produce `agentOutputSchema`, a Zod discriminated union on `type`.
- Produce the chat shape `{ type: 'chat'; reply: string }`.
- Produce the asset shape `{ type: 'asset'; brief: string; script: string; blenderVersion: '4.x'; preferenceProposals: PreferenceProposal[] }`.
- `AgentOutput` is inferred from the union. Script validation accepts only the asset shape.
- Produce a Mastra structured-output envelope `{ result: AgentOutput }` so Mastra can type the union schema as one top-level object.

- [ ] **Step 1: Write failing contract and asset-validation tests**

Add tests that accept chat and asset variants within the Mastra output envelope and reject malformed or unknown variants. Verify `parseAgentOutput` still validates an asset script. Add `routesNonCreationAndAmbiguousIntentToChat` to assert the Agent instructions direct greetings, general questions, ambiguous requests, and attachment-only turns to conversational output, reserving asset output for explicit creation intent.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm --filter @agent3d/shared exec vitest run src/contracts.test.ts`

Run: `pnpm --filter @agent3d/server exec vitest run src/agent/agent.test.ts`

Expected: FAIL because the shared output is not yet a `chat`/`asset` union and the asset parser does not enforce the asset variant.

- [ ] **Step 3: Implement the discriminated union and asset-only parser**

Export `assetGenerationOutputSchema` and define `agentOutputSchema` as the `type`-discriminated union. Keep current asset field constraints unchanged. Export `agentStructuredOutputSchema` as a strict `{ result: agentOutputSchema }` envelope, and use that envelope as the Mastra schema and output generic. Make `parseAgentOutput` parse only `assetGenerationOutputSchema`.

- [ ] **Step 4: Add intent-routing instructions and update agent fixtures**

Tell the agent to return `{ result: { type: 'chat', reply } }` for greetings, general questions, unclear requests, and attachment-only turns; attachment-only turns must ask whether to create an asset. Return `{ result: { type: 'asset', ... } }` only for explicit creation requests and use asset tools only in that mode. Update existing fake-model outputs to use the envelope.

- [ ] **Step 5: Run focused tests and confirm they pass**

Run: `pnpm --filter @agent3d/shared exec vitest run src/contracts.test.ts`

Run: `pnpm --filter @agent3d/server exec vitest run src/agent/agent.test.ts`

Expected: PASS.

### Task 2: Prevent artifact creation for conversational turns

**Files:**
- Modify: `apps/server/src/routes/chat.ts`
- Test: `apps/server/src/routes/api.test.ts`

**Interfaces:**
- Consume the `{ result: AgentOutput }` Mastra output envelope from Task 1 and unwrap it before branching.
- Keep the existing `/api/chat` stream contract; `data-asset` and `data-preference` are emitted only for an asset result.

- [ ] **Step 1: Write failing API regression tests**

Add route tests for a `chat` output on a greeting and on an attachment-only turn. Assert the assistant text is streamed and persisted, with no `data-asset` or `data-preference` chunk. For the image-only turn, capture the Agent input and assert it describes the upload as reference material without an instruction to create an asset. Add an invalid Blender script case and assert it emits no asset event. Keep the existing asset-output test and assert it still emits exactly one pending asset.

- [ ] **Step 2: Run the focused API tests and confirm they fail**

Run: `pnpm --filter @agent3d/server exec vitest run src/routes/api.test.ts`

Expected: FAIL because the route currently treats every structured output as an asset.

- [ ] **Step 3: Remove the synthetic image-generation instruction**

In `toModelMessages`, replace the empty-message fallback that asks to create an asset from attached images with neutral wording that identifies them as user-provided reference images.

- [ ] **Step 4: Branch persistence and stream events by output type**

In the stream completion path, parse the union result. For `chat`, use streamed text or `reply` as the assistant message and persist only text plus existing reasoning/tool parts. For `asset`, run `parseAgentOutput` for final static script validation before artifact persistence, then preserve the existing asset event, preference events, and assistant message parts.

- [ ] **Step 5: Run API regression tests**

Run: `pnpm --filter @agent3d/server exec vitest run src/routes/api.test.ts`

Expected: PASS, including the existing asset streaming, retry, and approval-related API coverage.

### Task 3: Verify workspace compatibility

**Files:**
- No additional files expected.

- [ ] **Step 1: Run the workspace test suite**

Run: `pnpm test`

Expected: PASS for all workspace tests.

- [ ] **Step 2: Run the workspace type check**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the workspace build**

Run: `pnpm build`

Expected: PASS with no build errors.
