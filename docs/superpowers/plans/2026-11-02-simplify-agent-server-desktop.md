# Simplify Agent, Server, and Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agent3D learning project a direct Desktop → Hono → Mastra flow with fixed ports, Agent-local API keys, inline Agent instructions/tools, and no mock or credential-broker path.

**Architecture:** Desktop talks only to Hono at `127.0.0.1:62586`; Hono talks only to Mastra at `127.0.0.1:62687`; Electron/Vite renderer uses `localhost:5173`. The Agent reads provider keys from `apps/agent/.env`; Hono sends one validated request context without API keys or service tokens.

**Tech Stack:** pnpm workspace, TypeScript, Mastra native `chatRoute`, Hono, Electron/Vite, React, Zod, SQLite, Vitest.

**Spec:** [2026-11-02-simplify-agent-server-desktop-design.md](../specs/2026-11-02-simplify-agent-server-desktop-design.md)

## Global Constraints

- Keep all package scripts unchanged.
- Fix Desktop renderer, Hono, and Mastra ports at `5173`, `62586`, and `62687`.
- Keep API keys in `apps/agent/.env`; read them in the Agent process and never put them in Hono/renderer requests or storage.
- Remove runtime mock providers, mock mode, fake Agent/model responses, and test doubles.
- Write the Agent instruction directly as a string and declare Agent tools in one object at the Agent definition.
- Pass one `requestContext` through the native Mastra route without middleware copying or rebuilding it.
- Keep Hono as the only Desktop API; keep Electron main from starting Hono or Agent.
- Keep conversation, attachment, preference, model-selection, streaming, and asset-approval behavior.
- Do not add dependencies or commit changes.

## Review Focus

- Missing API key for the selected provider must fail with a clear provider-specific error; pin this by calling the real Agent's `getModel({ requestContext })` with the selected provider key unset, without making a network request.
- A non-local or unexpected browser origin must still be rejected after token removal; pin this in the Hono origin test.
- Missing or malformed request context must fail before model invocation; pin schema rejection in the shared contract test and verify through the real local route.
- Greeting, ambiguous text, and attachment-only turns must stay chat-only; pin these with pure intent tests without a mock model.
- A port collision must fail visibly instead of silently choosing a different port; pin this in the server startup test.

---

### Task 1: Simplify Agent Context, Model Setup, and Tools

**Files:**
- Modify: `packages/shared/src/agent-service.ts`
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/agent/package.json` (remove unused direct `hono` dependency; scripts unchanged)
- Modify: `pnpm-lock.yaml`
- Modify: `apps/agent/src/mastra/agents/agent.ts`
- Modify: `apps/agent/src/mastra/agents/agent.test.ts`
- Modify: `apps/agent/src/mastra/index.ts`
- Modify: `apps/agent/src/mastra/asset-generation-intent.test.ts`
- Modify: `apps/agent/.env.example`
- Delete: `apps/agent/src/mastra/agent-context.ts` and `agent-context.test.ts`
- Delete: `apps/agent/src/mastra/model-adapter.ts` and `model-adapter.test.ts`
- Delete: `apps/agent/src/mastra/server-auth.ts` and `server-auth.test.ts`
- Delete: `apps/agent/src/mastra/tools/agent-tools.ts`
- Delete: `apps/agent/src/mastra/tools/agent-tools.test.ts`

**Interfaces:**
- Consumes: `agentChatRequestContextSchema` and the selected provider/model metadata from `@agent3d/shared`.
- Produces: one `agent3d` request-context object with model selection, latest user text, attachments, and preferences; no credential fields.
- Produces: one inline `tools` object and one direct Chinese `instructions` string in the Mastra `Agent` definition.

- [ ] **Step 1: Write credential-free shared-contract tests**

Change `contracts.test.ts` fixtures and assertions to prove model selection and Agent request context accept `providerId`, `modelId`, and `baseURL` without credential fields. Keep provider capabilities in Hono's provider catalog.

- [ ] **Step 2: Run the focused shared contract test**

Run: `pnpm --filter @agent3d/shared exec vitest run src/contracts.test.ts`
Expected: FAIL because the current schemas still require `apiKeyConfigured`, `protocol`, `apiKey`, and `supportsInlineImages`.

- [ ] **Step 3: Remove API-key fields from shared model and Agent-service schemas**

Update the schemas and derived types to remove `apiKeyConfigured`, `protocol`, `apiKey`, and Agent-side `supportsInlineImages`; run the same focused contract test and verify it passes.

- [ ] **Step 4: Write a real Agent missing-key test**

In `agent.test.ts`, construct a real Mastra `RequestContext` with a valid `agent3d` selection and call `agent.getModel({ requestContext })` after temporarily ensuring that provider's environment key is absent. Assert a clear error naming the required `.env` key. Do not send an HTTP request or substitute a model.

- [ ] **Step 5: Run the focused Agent test and verify it fails**

Run: `pnpm --filter @agent3d/agent exec vitest run src/mastra/agents/agent.test.ts`
Expected: FAIL because the Agent still expects the removed request-context credential field or does not yet report the missing environment key.

- [ ] **Step 6: Inline Agent request-context reads, model creation, instruction, and tools**

In `agent.ts`, read `requestContext.get('agent3d')` directly in Agent callbacks. Put the Chinese instruction directly in `instructions`; declare the few tools together in one `tools` object and close over that same context. Select the provider and read its key directly from `process.env` in the Agent model callback. Throw an explicit error if the selected provider's key is absent. Keep `hasExplicitAssetGenerationIntent` because multiple Agent decisions use it. Remove the unused Agent auth middleware and port resolver; configure the native Mastra server on `127.0.0.1:62687` directly.

- [ ] **Step 7: Remove fake-model tests and retain pure logic tests**

Delete tests that require a fake model, tool factory, or copied request context. Keep the new real Agent missing-key test, intent recognition tests, and Blender-script validation tests that call the real functions directly.

- [ ] **Step 8: Run Agent tests and type-check**

Run: `pnpm --filter @agent3d/agent exec vitest run src/mastra`
Expected: PASS without loading `@mastra/core/test-utils/llm-mock` or producing a fake Agent response.

Run: `pnpm --filter @agent3d/agent exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

### Task 2: Remove Server Mock/Credential Layers and Fix Server URLs

**Files:**
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/agent-client.ts`
- Modify: `apps/server/src/routes/models.ts`
- Modify: `apps/server/src/config/settings-repository.ts`
- Modify: `apps/server/src/middleware/local-origin.ts`
- Modify: `apps/server/src/http-errors.ts`
- Modify: `apps/server/src/config/provider-catalog.ts`
- Modify: `apps/server/src/index.test.ts`
- Modify: `apps/server/src/config/config.test.ts`
- Modify: `apps/server/src/routes/api.test.ts`
- Delete: `apps/server/src/config/env.ts` and mock/config cases that only validate removed variables
- Delete: `apps/server/src/config/model-resolver.ts` and tests that only verify credential resolution
- Delete: `apps/server/src/config/credential-client.ts` and `credential-client.test.ts`
- Delete: `apps/server/src/agent-client.test.ts` and `apps/server/src/testing/local-server.test.ts`
- Delete: `packages/shared/src/credentials.ts` and remove its export from `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: Task 1's credential-free `AgentServiceRequest` and provider/model selection contract.
- Produces: Hono API on `127.0.0.1:62586`; `AGENT_URL` is the literal `http://127.0.0.1:62687`; no mock branch, credential service, or service token.
- Produces: settings persistence that stores only model selections and continues to own conversations, attachments, preferences, and assets.

- [ ] **Step 1: Remove mock and credential-service paths from server configuration tests**

Change configuration tests to cover only retained configuration, especially `AGENT3D_DATA_DIR`. Remove tests asserting `AGENT3D_MOCK_MODE`, service tokens, broker ports, or configurable app URLs.

- [ ] **Step 2: Run the focused configuration tests and verify the old behavior fails**

Run: `pnpm --filter @agent3d/server exec vitest run src/config/config.test.ts`
Expected: PASS with no mock mode, credential broker, service-token, or URL/port override fields.

- [ ] **Step 3: Inline fixed service settings and remove credential resolution**

In the Server entrypoint and chat route, use the fixed Server port and Agent URL directly. Resolve provider capabilities from `provider-catalog.ts`; send only provider ID, model ID, and base URL to the Agent. Remove the injectable fetch option from `createAgentClient`. Remove credential dependencies from `createApp`, model routes, settings repository, and API error mapping. Keep local-origin checks and allow only the fixed dev renderer origin plus packaged `file:` origin.

- [ ] **Step 4: Remove fake Agent/fetch test responses**

Delete tests that inject `mock/model`, fake API keys, stubbed fetch responses, or fake Agent streams. Keep non-chat route tests using the real Hono app and SQLite storage. Exercise actual Agent calls manually through the running local processes rather than substituting a response in automated tests.

- [ ] **Step 5: Verify Server tests and types**

Run: `pnpm --filter @agent3d/server test`
Expected: PASS with no Agent/API fake response path.

Run: `pnpm --filter @agent3d/server typecheck`
Expected: PASS.

### Task 3: Make Desktop a Plain Hono Client

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/api/client.ts`
- Modify: `apps/desktop/src/renderer/src/api/types.ts`
- Modify: `apps/desktop/src/renderer/src/features/settings/ModelSettings.tsx`
- Delete: `apps/desktop/src/main/devtools.ts` and `devtools.test.ts` after inlining its one-use menu logic
- Delete: `apps/desktop/src/main/renderer-arguments.test.ts` (with its source)
- Delete: `apps/desktop/src/main/renderer-arguments.ts`
- Delete: `apps/desktop/src/main/credential-broker.ts` and its test
- Delete: `apps/desktop/src/main/credentials.ts` and its test
- Delete: single-use `apps/desktop/src/main/window-owner.ts` and `window-owner.test.ts`; inline its small lifecycle state into `index.ts`
- Delete: `apps/desktop/src/renderer/src/features/ui.test.tsx`; it relies on a fake `ApiClient` and `vi.fn` test doubles

**Interfaces:**
- Consumes: Task 2's Hono API at the fixed Server URL, with origin checks and no token header.
- Produces: renderer API client pointed directly at `http://127.0.0.1:62586`; preload exposes only values actually needed by the renderer.
- Produces: model settings UI that edits provider/model/base URL and tells the user to configure provider keys in `apps/agent/.env`; it has no API-key entry/status calls.

- [ ] **Step 1: Remove API-key state and controls from model settings**

Keep provider/model/base URL selection. Replace key-entry/status UI with a short instruction to set the provider variable in `apps/agent/.env`; remove API-key state and credential requests.

- [ ] **Step 2: Remove preload tokens and Electron credential services**

Delete safeStorage/broker startup and shutdown from `main/index.ts`; remove renderer argument parsing and the Hono API token. Inline the one-use window-owner/menu helpers where they add no separate behavior. Keep only the Electron window lifecycle.

- [ ] **Step 3: Point renderer API calls at fixed Hono and remove credential methods**

In `client.ts`, use `http://127.0.0.1:62586` directly and send no token header. Remove `DesktopBridge` token/URL injection when no longer needed, and delete `saveCredential`/`removeCredential` from `ApiClient`.

- [ ] **Step 4: Verify Desktop tests and types**

Run: `pnpm --filter @agent3d/desktop test`
Expected: PASS without mocked API-client functions or broker/renderer-token tests.

Run: `pnpm --filter @agent3d/desktop typecheck`
Expected: PASS.

### Task 4: Remove Workspace Mock Setup, Document the Direct Flow, and Verify

**Files:**
- Modify: `.env.example`
- Modify: `apps/agent/.env.example`
- Modify: `README.md`
- Modify: `scripts/workspace-smoke.test.mjs`
- Modify: remaining tests under `apps/agent`, `apps/server`, and `apps/desktop` that contain mock model/provider/client setup
- Keep package manifests and all `scripts` entries unchanged

**Interfaces:**
- Consumes: Tasks 1–3's fixed endpoints and direct Agent environment variables.
- Produces: quick-start instructions for setting a local `AGNES_API_KEY`, starting all three apps with `pnpm dev`, and testing the real chat flow.

- [ ] **Step 1: Simplify environment examples**

Keep only `AGENT3D_DATA_DIR` in the root environment example. Put `AGNES_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` in `apps/agent/.env.example`; do not add real credentials. Remove mock, URL, port, renderer-origin, API-token, and credential-broker variables.

- [ ] **Step 2: Update README and workspace smoke assertions**

Document the fixed ports and direct Desktop → Server → Agent request flow; explain that only the Agent reads provider keys and that packaged Electron still requires the fixed local services to be started separately. Update smoke assertions to protect fixed ports, unchanged package scripts, no broker/mock configuration, and Agent-local key configuration.

- [ ] **Step 3: Inline single-use wrappers across the three apps**

Trace production call sites under `apps/agent`, `apps/server`, and `apps/desktop`. Inline or remove single-use functions/modules that only forward values or create one-off objects; keep only repeated logic, required boundary validation, and clear framework/domain boundaries. Do not create a replacement helper layer.

- [ ] **Step 4: Search for prohibited paths and test doubles**

Run: `rg -n "AGENT3D_MOCK_MODE|createMockModel|mock/model|mock-only-key|credential-broker|CREDENTIAL_BROKER|AGENT3D_AGENT_TOKEN|AGENT3D_SERVER_TOKEN|vi\\.mock|vi\\.fn|mockResolvedValue|mockImplementation" apps packages/shared/src .env.example apps/agent/.env.example`
Expected: no runtime mock, credential broker, service-token, fake response, or test-double matches.

- [ ] **Step 5: Run workspace tests and type checks**

Run: `pnpm test`
Expected: all retained smoke, shared, Server, and Desktop tests pass without mock models or fake Agent responses.

Run: `pnpm typecheck`
Expected: all workspace TypeScript checks pass.

- [ ] **Step 6: Build the three applications**

Run: `pnpm --filter @agent3d/agent build`
Expected: Mastra build succeeds.

Run: `pnpm --filter @agent3d/server build`
Expected: Hono Server build succeeds.

Run: `pnpm --filter @agent3d/desktop build`
Expected: Electron/Vite build succeeds with the renderer fixed at port 5173.

- [ ] **Step 7: Run one real local three-process smoke test**

Start `pnpm dev` with valid local Agent provider credentials. Verify the listeners are exactly `127.0.0.1:62687` and `127.0.0.1:62586`, the renderer is `http://localhost:5173`, and Desktop chat streams through Hono to the real Mastra Agent. Confirm greetings and attachment-only input do not generate assets, and an explicit asset request returns an approval proposal. Do not use a mock model or a test substitute.
