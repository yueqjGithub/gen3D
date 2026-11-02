# Separate Mastra Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Mastra into a standalone `apps/agent` HTTP service, keep Hono as the renderer-facing gateway, and update the learning documentation.

**Architecture:** `apps/agent` owns Mastra model/Agent/tool/prompt logic and exposes a loopback-only NDJSON streaming endpoint. Hono prepares trusted conversation context, calls the Agent service using shared DTOs, converts its stable events into the current AI SDK UI stream, and retains persistence and security responsibilities. Root `pnpm dev` uses pnpm workspace scripts to start Agent and Electron in parallel; no custom launcher is added.

**Tech Stack:** pnpm 12 workspace, TypeScript, Mastra, Node `http`, Hono, AI SDK UI streams, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-separate-mastra-service-design.md`

## Global Constraints

- The renderer calls only the Hono API.
- Agent service binds only to `127.0.0.1`, requires an internal token, and does not persist application data.
- Hono owns renderer authentication, model/key resolution, attachment ownership and preparation, conversation/asset persistence, and approval.
- Never log Agent request bodies, model API keys, attachment contents, or provider response bodies.
- Preserve the current renderer-visible API and AI SDK UI message chunks.
- Cancel the Hono-to-Agent request and upstream Mastra stream when the renderer cancels.
- Use the one shared Blender script validator in Agent generation and Hono persistence/approval; user approval remains required before download.
- Electron does not import or instantiate Mastra.
- Add concise comments to public shared exports and non-obvious service-boundary/security behavior; avoid comments that only restate code.

## Review Focus

- Missing/malformed internal auth token or an untrusted non-loopback bind must be rejected; cover in the Agent HTTP tests.
- Invalid NDJSON, truncated streams, or Agent error events must fail the Hono turn without persisting an incomplete success; cover in Hono client/route tests.
- Renderer abort during an Agent stream must propagate cancellation and not persist a successful turn; cover in Hono API integration tests.
- Ordinary greetings must stay conversational and never create assets without clear generation intent; cover in mock Agent tests and a prompt-level Agent test.
- Image/document context and preference data must reach Agent without giving Agent access to Hono storage; assert the prepared request in Hono route integration tests.
- Agent result must not create an asset unless it is an asset variant with a valid script; cover in the existing route tests plus Agent script-validation tests.

---

### Task 1: Define the Agent HTTP boundary

**Files:**
- Create: `packages/shared/src/agent-service.ts`
- Move: `apps/server/src/agent/validate-script.ts` to `packages/shared/src/blender-script.ts`
- Test: `packages/shared/src/blender-script.test.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/contracts.test.ts`
- Modify: `apps/server/src/agent/agent.test.ts` (move existing validator cases to shared tests)

**Interfaces:**
- `AgentServiceRequest`: `{ model: AgentServiceModelConfig, messages: { role: 'user' | 'assistant'; content: string }[], documents: { fileName, mediaType, text }[], images: { fileName, mediaType, dataUrl }[], preferences: { key, value }[] }`; `AgentServiceModelConfig` has `providerId`, `modelId`, `baseURL`, `protocol`, `apiKey`, and `supportsInlineImages`.
- `AgentServiceEvent`: `{type, id}` text/reasoning start/end events; `{type, id, delta}` text/reasoning delta events; `{type: 'tool-activity', toolCallId, toolName, state: 'started' | 'completed'}`; `{type: 'result', output: AgentOutput}`; or `{type: 'error', code, message, retryable}`.
- `agentServiceHealthSchema`: `{ status: 'ready' }`, without credentials or runtime internals.
- `validateBlenderScript(script: string): ScriptValidationResult` is one shared pure validator used by Agent generation and Hono approval.
- Keep Mastra-specific types and schemas out of `packages/shared`.

- [ ] **Step 1: Write the failing contract and validator tests**

Add `blender-script.test.ts` by moving the existing empty/oversized/missing-bpy/blocked-pattern assertions from `apps/server/src/agent/agent.test.ts`. Add contract cases to `contracts.test.ts` that accept a valid request with text and image context and each event variant, and reject malformed model/message fields, unknown event types, and unsafe/unbounded request data.

- [ ] **Step 2: Run both shared test files and confirm the new exports fail**

Run: `pnpm --filter @agent3d/shared exec vitest run src/contracts.test.ts src/blender-script.test.ts`

Expected: FAIL because the Agent service schemas and shared validator are not yet exported.

- [ ] **Step 3: Implement bounded Zod DTOs and exports**

Define explicit limits in the schema for request messages, attachment context, image data URL sizes, preferences, event text, and result object. Keep `apiKey` only on the server-to-server request type; never include it in any event or health response. Move the current pure Blender validator and its tests to the shared package rather than duplicating the rule across services. Document each new public export with a concise purpose comment.

- [ ] **Step 4: Run shared tests and typecheck**

Run: `pnpm --filter @agent3d/shared test`

Run: `pnpm --filter @agent3d/shared typecheck`

Expected: PASS.

### Task 2: Create the standalone Mastra Agent service

**Files:**
- Create: `apps/agent/package.json`
- Create: `apps/agent/tsconfig.json`
- Modify: `pnpm-workspace.yaml` to explicitly deny esbuild lifecycle scripts
- Create: `apps/agent/src/index.ts`
- Create: `apps/agent/src/http.ts`
- Create: `apps/agent/src/asset-agent.ts`
- Create: `apps/agent/src/runner.ts`
- Create: `apps/agent/src/mastra.ts`
- Create: `apps/agent/src/model-adapter.ts`
- Create: `apps/agent/src/prompts/asset-agent.ts`
- Create: `apps/agent/src/tools/analyze-input.ts`
- Create: `apps/agent/src/tools/build-asset-brief.ts`
- Create: `apps/agent/src/tools/generate-blender-script.ts`
- Create: `apps/agent/src/tools/update-preferences.ts`
- Create: `apps/agent/src/testing/mock-agent.ts`
- Create: `apps/agent/src/testing/mock-agent.test.ts`
- Create: `apps/agent/src/agent.test.ts`
- Create: `apps/agent/src/http.test.ts`
- Modify: `apps/server/src/agent/agent.test.ts` (remove/move Agent-specific tests)

**Interfaces:**
- Consume `AgentServiceRequest`, `AgentServiceEvent`, and `agentServiceRequestSchema` from Task 1.
- `createAgentHttpServer({ host, port, token, runAgent })` binds only to `127.0.0.1`, serves `GET /health` and `POST /chat`, and checks `X-Agent3D-Agent-Token`; `runAgent(request, { signal })` returns `AsyncIterable<AgentServiceEvent>`.
- `POST /chat` responds with `application/x-ndjson`; each line is one validated `AgentServiceEvent`, ending with one `result` or `error`.
- Agent tools operate only on request-provided document/image/preferences context; they do not import Hono repositories or desktop storage.
- `apps/agent/package.json` exposes `dev`, `test`, `typecheck`, and `build` scripts; `dev` reads the root `.env` file when present.

- [ ] **Step 1: Scaffold the Agent workspace test target**

Add the `apps/agent` workspace package manifest and TypeScript configuration without adding an HTTP or Agent implementation. Add `@mastra/core`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `ai`, `zod`, and `tsx` at the project's existing compatible versions; retain the current server dependencies until Task 3 removes the old Agent imports. Explicitly deny the esbuild lifecycle script in pnpm configuration rather than approving it; verify the packaged binary and `tsx` work.

- [ ] **Step 2: Write failing Agent service HTTP tests**

Test health readiness, required token, malformed request rejection, NDJSON result termination, safe model failure events, cancellation, and absence of API key/request body from logs. Add mock Agent unit tests proving “你好” remains a chat response while explicit asset-generation intent returns an asset; keep the existing Hono integration tests in the server package for Task 3 to migrate to a fake Agent service. Inject a fake Agent/model dependency so tests never call an external provider.

- [ ] **Step 3: Run the new Agent tests and confirm they fail**

Run: `pnpm --filter @agent3d/agent exec vitest run src/http.test.ts`

Expected: FAIL because `createAgentHttpServer` and the endpoint behavior do not exist yet.

- [ ] **Step 4: Move Mastra ownership and adapt tools to request context**

Move Agent factories, Mastra/model adapters, prompts, and tools out of `apps/server/src/agent`. Copy the server mock Agent behavior into `apps/agent/src/testing/mock-agent.ts`; leave the old server implementation and its Hono integration tests until Task 3. Import the shared Blender validator from `@agent3d/shared`. Change Agent tools to read only request-provided document/image/preferences context; they must not import Hono repositories or storage.

- [ ] **Step 5: Implement the Agent HTTP service**

Use Node's built-in HTTP server, request schema validation, loopback-only binding, internal-token comparison, bounded NDJSON writes, and request abort propagation. Create a request-scoped Agent per model selection, map Mastra stream chunks into the stable event union, and validate the final structured result and Blender script before emitting it. Reject requests when `runAgent` ends without exactly one terminal result/error event.

- [ ] **Step 6: Implement the Agent entrypoint**

Read `AGENT3D_AGENT_PORT` (default `62687`), `AGENT3D_AGENT_TOKEN`, and mock-mode configuration. Bind only to `127.0.0.1`, fail clearly if the token is missing, and log the listening URL without credentials.

- [ ] **Step 7: Run Agent tests and typecheck**

Run: `pnpm --filter @agent3d/agent test`

Run: `pnpm --filter @agent3d/agent typecheck`

Expected: PASS.

### Task 3: Replace in-process Mastra with the Hono Agent client

**Files:**
- Create: `apps/server/src/agent-client.ts`
- Test: `apps/server/src/agent-client.test.ts`
- Modify: `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/routes/api.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/http-errors.ts`
- Move: `apps/server/src/agent/extract-document.ts` to `apps/server/src/attachments/extract-document.ts`
- Move: `apps/server/src/agent/tools/analyze-input.ts` to `apps/server/src/attachments/prepare-conversation-input.ts`
- Move: `apps/server/src/streaming/mastra-ui-stream.ts` to `apps/server/src/streaming/agent-ui-stream.ts` and convert stable Agent service events, with no Mastra imports
- Modify: `apps/server/package.json`
- Delete: Mastra implementation files under `apps/server/src/agent` after their responsibilities move to `apps/agent`

**Interfaces:**
- Consume `AgentServiceRequest`, `AgentServiceEvent`, and `agentServiceEventSchema` from Task 1.
- `createAgentClient({ baseURL, token, fetch? })` exposes `stream(request, { signal }): AsyncIterable<AgentServiceEvent>`.
- Hono persists a pending artifact only after receiving and validating a final `result` event.

- [ ] **Step 1: Write failing Agent client tests**

Cover valid event iteration, malformed NDJSON rejection, non-2xx response errors, a missing terminal event, safe service errors, and request abort propagation.

- [ ] **Step 2: Run focused client tests and confirm they fail**

Run: `pnpm --filter @agent3d/server exec vitest run src/agent-client.test.ts`

Expected: FAIL because `createAgentClient` does not yet exist.

- [ ] **Step 3: Implement the bounded NDJSON client**

Parse and validate each complete line incrementally, reject oversized or malformed events, surface safe HTTP/service errors, and abort the fetch/body reader when the caller's signal aborts.

- [ ] **Step 4: Update Hono chat routing to consume Agent service events**

Keep the existing `/api/chat` and AI SDK UI stream behavior. Build the Agent request after attachment preparation and model/key resolution. Translate stable text/reasoning/tool events to the existing renderer chunks. Validate the final result and script using the shared validator before persisting or emitting an asset. Remove all Mastra-specific imports and runtime types from Hono.

- [ ] **Step 5: Add Hono integration regressions**

Use an in-process fake Agent HTTP server to verify the exact prepared messages/document/image/preferences context, chat and asset paths, no artifact on chat results, one artifact on valid asset results, no artifact on invalid scripts or Agent errors, cancellation without success persistence, and no secret in streams/logs.

- [ ] **Step 6: Remove Mastra dependencies from Hono and run focused tests**

Remove `@mastra/core`, `@ai-sdk/anthropic`, and `@ai-sdk/openai-compatible` from `apps/server/package.json` after all old Agent imports and Hono mock integrations have moved. Run:

`pnpm --filter @agent3d/server test`

Expected: PASS with no direct Mastra dependency or implementation import in `apps/server`.

### Task 4: Remove direct Agent imports from Electron

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/renderer-arguments.ts`
- Test: `apps/desktop/src/main/renderer-arguments.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/server/src/config/env.ts`
- Modify: `apps/server/src/config/config.test.ts`

**Interfaces:**
- `readServerEnvironment(source)` requires the loopback `AGENT3D_AGENT_URL` and `AGENT3D_AGENT_TOKEN` and returns them with the existing mock/key settings.
- `createRendererArguments(apiBaseUrl, apiToken)` returns only the existing Hono URL/token switches.
- Electron supplies the Hono Agent client with `AGENT3D_AGENT_URL` and `AGENT3D_AGENT_TOKEN`; it does not spawn Agent or import Agent source.
- Root development launcher supplies the same local URL/token to Agent and desktop; renderer receives only the existing Hono base URL and token.
- Preserve safeStorage credential resolution in Electron; selected model/API key reaches Agent only in the authenticated Hono-to-Agent request.

- [ ] **Step 1: Write failing server-config and renderer-argument tests**

Extend `config.test.ts` to reject missing or non-loopback Agent URL and missing token. Test `createRendererArguments(apiBaseUrl, apiToken)` returns only the existing Hono URL/token switches, never Agent URL/token.

- [ ] **Step 2: Run the focused config tests and confirm they fail**

Run: `pnpm --filter @agent3d/server exec vitest run src/config/config.test.ts`

Run: `pnpm --filter @agent3d/desktop exec vitest run src/main/renderer-arguments.test.ts`

Expected: FAIL because the Agent service config and renderer argument builder do not yet include the new behavior.

- [ ] **Step 3: Replace direct Agent construction with the Hono Agent client**

Remove `createMastra`, `createMastraModel`, and Agent mock imports from Electron. Inject `createAgentClient` into `createApp`; retain Hono's current Electron-managed local API and database lifecycle.

- [ ] **Step 4: Remove duplicated Mastra/provider dependencies from Electron**

Remove `@mastra/core`, `@ai-sdk/anthropic`, and `@ai-sdk/openai-compatible` from `apps/desktop/package.json`; retain dependencies used by Electron, renderer, or Hono.

- [ ] **Step 5: Run desktop tests and typecheck**

Run: `pnpm --filter @agent3d/desktop test`

Run: `pnpm --filter @agent3d/desktop typecheck`

Expected: PASS.

### Task 5: Configure workspace scripts and update README

**Files:**
- Modify: root `package.json`
- Modify: `apps/agent/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `.env.example`
- Modify: `apps/server/.env.example`
- Modify: `README.md`
- Modify: `scripts/workspace-smoke.test.mjs`

**Interfaces:**
- `pnpm --filter @agent3d/agent dev` starts only the Agent service and loads the root `.env` when present.
- Root `pnpm dev` runs `@agent3d/agent` and `@agent3d/desktop` `dev` scripts concurrently using pnpm `--parallel`; Ctrl+C is handled by pnpm.
- Direct per-project test, typecheck, and build commands remain available.

- [ ] **Step 1: Add explicit Agent and root workspace dev scripts**

Set the Agent package `dev` script to load `../../.env` if present and run its TypeScript entrypoint. Set root `dev` to `pnpm --parallel --filter @agent3d/agent --filter @agent3d/desktop dev`. Add loopback URL and a local-only token to `.env.example` so both independent processes read the same values. Keep the existing desktop script and service entrypoints simple; do not add a launcher or readiness polling.

- [ ] **Step 2: Verify the workspace smoke test fails before updating it**

Run: `pnpm exec node --test scripts/workspace-smoke.test.mjs`

Expected: FAIL because the Agent workspace and root parallel dev script are not yet declared.

- [ ] **Step 3: Extend workspace smoke tests and update README**

Assert the Agent workspace, root parallel dev script, and Agent `dev`/`test`/`typecheck`/`build` scripts. Document exact standalone/root commands, required shared `AGENT3D_AGENT_TOKEN` configuration for separate terminals, project responsibilities, Agent HTTP boundary, and a traceable “hello” chat flow. Update Agent paths from `apps/server/src/agent` to `apps/agent/src`.

- [ ] **Step 4: Run workspace smoke tests, full tests, typecheck, and build**

Run: `pnpm exec node --test scripts/workspace-smoke.test.mjs`

Run: `pnpm test`

Run: `pnpm typecheck`

Run: `pnpm build`

Expected: PASS; Electron output contains no Mastra runtime imports and Agent builds independently.
