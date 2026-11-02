# Mastra Native Server and Standalone Hono Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm dev` start a native Mastra Agent server, a standalone Hono API, and Electron as three independent local processes without losing existing data or exposing local credentials to the renderer.

**Architecture:** Mastra owns the Agent HTTP server and `/chat/:agentId` AI SDK v7 stream. Hono remains the renderer-facing API and data owner, adapting Mastra's UI-message stream before validating and persisting results. Electron main hosts the authenticated `safeStorage` credential broker and opens the renderer against Hono.

**Tech Stack:** pnpm 12 workspace, Node.js, Mastra Core 1.81.0, `@mastra/ai-sdk` 1.11.3, Mastra CLI 1.37.0, AI SDK 7.0.159, Hono, Electron, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-separate-mastra-native-chat-route-design.md`

## Global Constraints

- Every local listener binds only to `127.0.0.1`.
- The renderer calls only Hono; Agent and credential-broker credentials remain in main/server processes.
- Hono owns conversations, attachments, preferences, assets, model selection, credential resolution, validation, and approval.
- Preserve request-scoped model selection, document/image/preference context, stream cancellation, and pending-asset approval.
- Keep packaged-build backend supervision, readiness polling, a custom launcher, and image-generation workflows out of scope.
- Keep model keys, attachment contents, conversation history, and preference values out of logs.
- Use `@mastra/ai-sdk` 1.11.3 with AI SDK 7.0.159 and Mastra Core 1.81.0; use `mastra` CLI 1.37.0, whose peer range includes Core 1.81.0.
- Raise the root Node engine floor from `>=22.12.0` to `>=22.13.0`, required by the installed Mastra AI SDK and CLI; the current runtime is Node 24.22.1.
- Do not commit, merge, or push; the user will handle branch setup and integration.

## Review Focus

- A missing, duplicate, malformed, or invalid `data-structured-output` chunk must fail the turn and never persist an asset. Test this in Task 2.
- Malformed, oversized, unterminated, and non-success Agent streams must produce safe, retryable Hono failures without leaking response bodies. Test this in Task 2.
- A renderer must not be able to supply or override trusted model credentials, documents, images, or preferences in `requestContext`. Test the Hono-to-Agent payload boundary in Tasks 1 and 2.
- Cancellation or unavailable Agent/broker services must not create successful assistant messages or assets; failures must remain explicit and retryable. Test this in Tasks 2 and 4.
- Existing SQLite and attachment data must resolve to the same Electron user-data location after process separation. Test the default and override paths in Task 4.

---

### Task 1: Register a request-scoped Agent on Mastra's native server

**Files:**
- Modify: `packages/shared/src/agent-service.ts`
- Modify: `apps/agent/package.json`
- Create: `apps/agent/src/mastra/index.ts`
- Modify: `apps/agent/src/mastra.ts`
- Modify: `apps/agent/src/asset-agent.ts`
- Modify: `apps/agent/src/tools/analyze-input.ts`
- Modify: `apps/agent/src/tools/build-asset-brief.ts`
- Modify: `apps/agent/src/tools/update-preferences.ts`
- Modify: `apps/agent/src/tools/generate-blender-script.ts`
- Modify: `apps/agent/src/model-adapter.ts`
- Modify: `apps/agent/src/testing/mock-agent.ts`
- Modify: `apps/agent/src/agent.test.ts`
- Delete: `apps/agent/src/index.ts`
- Delete: `apps/agent/src/http.ts`
- Delete: `apps/agent/src/runner.ts`

**Interfaces:**
- Consumes: `AgentServiceRequest` and existing prepared-context schemas from `@agent3d/shared`.
- Produces: `AgentChatRequestContext` schema/type in shared code, containing the validated model config, bounded prepared documents, image metadata (not image bytes), saved preferences, and the latest user text. The registered agent reads it from `requestContext.get('agent3d')`.
- Produces: `assetAgent` registered in `src/mastra/index.ts`; Mastra config registers `chatRoute({ path: '/chat/:agentId', sendReasoning: true, version: 'v7' })` with authentication middleware.

- [ ] **Step 1: Write failing contract and Mastra route tests**

Add tests that assert:

1. `agentChatRequestContextSchema` accepts a valid context and rejects unknown keys, invalid model configuration, and oversized prepared document/image metadata.
2. The registered Agent resolves different configured model IDs from two distinct validated request contexts without shared mutable model state.
3. Prepared documents, image metadata, and preferences are available to tools for the current request only.
4. The route rejects a missing/incorrect `X-Agent3D-Agent-Token`, and an authorized request emits AI SDK v7 `reasoning-*` chunks and exactly one `data-structured-output` chunk with `{ object: { result: ... } }`.
5. In mock mode, “你好” yields `result.type === 'chat'`, while an explicit “帮我生成一个碗” request yields `result.type === 'asset'`; both still execute through the Mastra route.
6. Aborting the route request aborts the Agent stream.

- [ ] **Step 2: Run the Agent tests and confirm the new cases fail**

Run: `pnpm --filter @agent3d/agent test`

Expected: the new request-context, native-route, and mock-route tests fail because the Agent still uses the hand-written listener and request-captured dependencies.

- [ ] **Step 3: Add the validated dynamic request context**

Add strict `agentChatRequestContextSchema` and `AgentChatRequestContext` exports. In `asset-agent.ts`, resolve the model with Mastra's `DynamicArgument` callback using `requestContext.get('agent3d')`; define tools dynamically so each execution reads the same validated request context. Keep `agentStructuredOutputSchema` in the Agent's `defaultOptions.structuredOutput.schema`. Do not retain documents, images, preferences, or model credentials in a module-level or agent-construction closure.

- [ ] **Step 4: Add the native server entry and authenticated `chatRoute()`**

Create `src/mastra/index.ts` as the Mastra CLI entry point. Register the Agent and the v7 `chatRoute`; attach a route middleware that checks the internal Agent token with a timing-safe comparison. Bind the server to `127.0.0.1`, use the configured Agent port, and disable CORS because only the Hono Node process calls this endpoint. Keep the provider-key and request-context values out of logs.
Keep the existing `LibSQLStore` configuration; remove the `console.log()` that currently prints the complete dependency object.

- [ ] **Step 5: Keep deterministic mock mode on the native route**

Resolve `providerId === 'mock'` to a deterministic AI SDK mock language model built from the validated context's latest user text. Preserve the existing greeting-versus-explicit-asset behavior and safe demo output; do not bypass `chatRoute()` or add a second HTTP endpoint.

- [ ] **Step 6: Remove the obsolete custom Agent transport**

Remove `src/index.ts`, `src/http.ts`, and `src/runner.ts` after their request validation, abort behavior, and test coverage have moved to the native route. Replace the Agent `dev` script with the Mastra CLI entry command, while loading the repository-root `.env` using Node's `--env-file-if-exists=../../.env` option. Add `mastra@1.37.0` as an Agent development dependency.
Set the Agent `build` script to `mastra build`; retain a separate `typecheck` script using `tsc --noEmit`.

- [ ] **Step 7: Verify the Agent task**

Run: `pnpm --filter @agent3d/agent test`

Expected: all context, tool isolation, authenticated route, mock intent, structured output, and cancellation tests pass.

Run: `pnpm --filter @agent3d/agent typecheck`

Expected: no TypeScript errors.

---

### Task 2: Adapt Hono to the Mastra AI SDK UI-message stream

**Files:**
- Modify: `apps/server/src/agent-client.ts`
- Modify: `apps/server/src/agent-client.test.ts`
- Modify: `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/routes/chat.test.ts`
- Modify: `apps/server/src/streaming/agent-ui-stream.ts`
- Modify: `apps/server/src/streaming/agent-ui-stream.test.ts`
- Modify: `packages/shared/src/agent-service.ts`

**Interfaces:**
- Consumes: `AgentChatRequestContext`, `/chat/assetAgent`, the internal Agent token, and AI SDK v7 UI messages from Task 1.
- Produces: `AgentClient.stream(request, { signal }): AsyncIterable<UIMessageChunk>`; the client converts validated `AgentServiceRequest` data into UI messages plus `requestContext: { agent3d: AgentChatRequestContext }`.
- Hono accepts structured output only from the v7 `data-structured-output` chunk, where `chunk.data.object` must satisfy `agentStructuredOutputSchema`.

- [ ] **Step 1: Write failing Agent client and Hono stream tests**

Add tests asserting:

1. The client POSTs to `/chat/asset-creation-agent`, sends the internal token, maps message history and prepared images to AI SDK v7 message parts, and serializes only Hono-built request context.
2. The client decodes a valid Mastra UI-message SSE stream into typed chunks and rejects malformed JSON, invalid chunks, oversized lines, non-2xx responses, and a stream ending without a `finish` chunk.
3. Hono forwards text, reasoning, and sanitized tool-activity chunks to its existing renderer stream; it never forwards raw tool arguments or Agent error bodies.
4. Exactly one valid structured-output chunk completes a chat turn; missing, duplicate, malformed, or invalid output fails the turn and creates no asset.
5. A valid asset result creates one pending artifact only after Blender script validation; a `type: 'chat'` result never creates an artifact.
6. Aborting while the Agent client is streaming cancels its reader and leaves the turn failed/retryable with no asset.

- [ ] **Step 2: Run the targeted server tests and confirm the new cases fail**

Run: `pnpm --filter @agent3d/server test`

Expected: the new stream tests fail because the client and chat route currently use the private NDJSON event protocol.

- [ ] **Step 3: Implement the AI SDK v7 client stream parser**

Change the Agent client to POST validated UI messages and request context to `${baseURL}/chat/asset-creation-agent`, use the internal token header, and parse SSE with the installed AI SDK stream helpers (`parseJsonEventStream` and `uiMessageChunkSchema`). Enforce the existing event-size bound, propagate aborts, and return safe errors without exposing raw response content.

- [ ] **Step 4: Adapt UI stream persistence and result validation**

Update the Hono chat route to adapt only recognized text, reasoning, and sanitized tool-activity chunks. Capture `data-structured-output` separately; require exactly one schema-valid `chunk.data.object`, and continue to validate Blender scripts before creating pending artifacts. Preserve existing replay, idempotency, preference proposals, renderer stream format, and safe error messages.

- [ ] **Step 5: Verify the Hono adapter**

Run: `pnpm --filter @agent3d/server test`

Expected: AI SDK stream parsing, renderer compatibility, invalid/missing/duplicate output rejection, cancellation, and no-persistence-on-failure tests pass.

---

### Task 3: Add the Electron-hosted credential broker

**Files:**
- Create: `apps/desktop/src/main/credential-broker.ts`
- Create: `apps/desktop/src/main/credential-broker.test.ts`
- Modify: `apps/desktop/src/main/credentials.ts`
- Modify: `apps/desktop/src/main/credentials.test.ts`
- Create: `apps/server/src/config/credential-client.ts`
- Create: `apps/server/src/config/credential-client.test.ts`
- Modify: `apps/server/src/http-errors.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: the existing `CredentialStore` interface and `createSafeStorageCredentialStore()`.
- Produces: a loopback-only broker with strict `GET /credentials/:providerId` (`{ apiKey: string | null }`), `PUT /credentials/:providerId` (`{ apiKey: string }`), and `DELETE /credentials/:providerId` (`204`) operations, authenticated with `X-Agent3D-Credential-Token`.
- Produces: `createCredentialClient({ baseURL, token, fetch? }): CredentialStore` for Hono. Only the broker accesses Electron `safeStorage`; the client returns safe errors and never logs or exposes credential values.

- [ ] **Step 1: Write failing broker, client, and safeStorage tests**

Add tests asserting:

1. Missing/wrong broker tokens are rejected with a generic `401`; invalid provider IDs and malformed request bodies are rejected.
2. A missing credential returns `null`; set/get/delete round-trip through the encrypted store without the stored file containing plaintext.
3. Broker and client errors do not include request bodies, response bodies, or keys.
4. The client propagates aborts and reports broker unavailability explicitly.
5. The broker lifecycle starts on `127.0.0.1`, closes during shutdown, and its token is never passed to `createRendererArguments()`.

- [ ] **Step 2: Run the credential-focused tests and confirm they fail**

Run: `pnpm --filter @agent3d/desktop test -- src/main/credential-broker.test.ts src/main/credentials.test.ts`

Expected: broker and safeStorage tests fail because the broker module and asynchronous adapter do not exist yet.

Run: `pnpm --filter @agent3d/server test -- src/config/credential-client.test.ts`

Expected: client tests fail because the credential-client module does not exist yet.

- [ ] **Step 3: Implement the authenticated broker and Hono client**

Host the three credential operations in Electron main on `127.0.0.1` using the configured broker port/token. Have Hono call only those operations. Keep environment-key fallback and its per-process disable-on-delete behavior in Hono, not in renderer code. Convert broker unavailability to a safe, retryable `502` without logging or returning raw response bodies.

- [ ] **Step 4: Use Electron's non-deprecated asynchronous safeStorage API**

Update the safeStorage adapter and store to use `isAsyncEncryptionAvailable()`, `encryptStringAsync()`, and `decryptStringAsync()` from the installed Electron version. Keep atomic encrypted-file writes and explicit unavailable-encryption errors.

- [ ] **Step 5: Verify credential broker behavior**

Run: `pnpm --filter @agent3d/desktop test -- src/main/credential-broker.test.ts src/main/credentials.test.ts`

Expected: authentication, safeStorage, deletion, missing-credential, abort, and safe-error tests pass.

Run: `pnpm --filter @agent3d/server test -- src/config/credential-client.test.ts`

Expected: client contract and failure tests pass.

---

### Task 4: Run Hono independently and preserve the existing user-data directory

**Files:**
- Create: `apps/server/src/index.ts`
- Create: `apps/server/src/config/data-directory.ts`
- Create: `apps/server/src/config/data-directory.test.ts`
- Modify: `apps/server/src/config/env.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/renderer-arguments.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron.vite.config.ts`

**Interfaces:**
- Consumes: the credential client from Task 3; existing Hono repositories, model resolver, and app factory.
- Produces: `resolveDataDirectory(source, platform, homeDirectory, appName): string`, honoring `AGENT3D_DATA_DIR` when configured and otherwise matching Electron's platform-specific `appData + app.getName() + data` location.
- Produces: an `@agent3d/server` entrypoint that owns the database and Hono listener and binds only to `127.0.0.1`.
- Produces: Electron main opens the renderer with configured `AGENT3D_SERVER_URL` and `AGENT3D_SERVER_TOKEN`; it no longer constructs Hono or opens SQLite.

- [ ] **Step 1: Write failing data-path, environment, and ownership tests**

Add tests asserting:

1. The default Windows path uses `%APPDATA%` and the Electron application name, with the database under `data/agent3d.sqlite`; macOS and Linux follow Electron's `appData` conventions.
2. A configured `AGENT3D_DATA_DIR` is resolved and used without moving, deleting, or migrating existing files.
3. Electron's expected `app.getPath('userData')` matches the shared default path; a mismatch fails explicitly rather than silently opening a new database.
4. The Hono entrypoint wires one database connection to all repositories and closes it on shutdown.
5. Hono binds the configured port on `127.0.0.1`; an invalid port or missing required token fails startup.
6. Hono returns an explicit retryable upstream-unavailable error when Agent or credential broker is not yet listening.

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `pnpm --filter @agent3d/server test -- src/config/data-directory.test.ts`

Expected: data-directory helper and independent entrypoint behavior are not implemented.

- [ ] **Step 3: Implement deterministic data-directory resolution**

Use the existing Electron app name from `apps/desktop/package.json` and Electron's documented platform conventions for the default user-data root. Use the same resolver in server and Electron main; verify it against `app.getPath('userData')` before Electron creates the renderer. Preserve the current `data/agent3d.sqlite` and `data/attachments` paths.

- [ ] **Step 4: Create the standalone Hono process**

Add a server entrypoint that reads the root `.env`, resolves the Hono URL/token, initializes the database and existing repositories, wraps the broker client with the existing Agnes environment-key fallback, creates the Hono app, and starts `@hono/node-server` on loopback. Close the listener and database on `SIGINT`/`SIGTERM`.
Add `dev`, `build`, `test`, and `typecheck` scripts to the server workspace; its build must emit runnable Node ESM into `dist` rather than reuse the no-emit typecheck.

- [ ] **Step 5: Remove Hono/database ownership from Electron**

Keep Electron main responsible only for its window, renderer token handoff, safeStorage broker, and lifecycle cleanup. Replace the random per-process Hono token and dynamic port with configured local values. Fix the Electron renderer dev server to a strict `http://localhost:5173` origin so Hono's origin policy remains deterministic. Remove backend-only direct dependencies from the desktop package (`@hono/node-server`, `better-sqlite3`, `hono`, and `pdfjs-dist`) after confirming no remaining desktop imports.

- [ ] **Step 6: Verify path preservation and process ownership**

Run: `pnpm --filter @agent3d/server test -- src/config/data-directory.test.ts`

Expected: default and override path tests pass, and an existing seeded database remains readable at the same path.

Run: `pnpm --filter @agent3d/desktop test`

Expected: credential broker and desktop lifecycle tests pass.

---

### Task 5: Wire three workspace commands and update the learning documentation

**Files:**
- Modify: `package.json`
- Modify: `apps/agent/package.json`
- Modify: `apps/server/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `scripts/workspace-smoke.test.mjs`

**Interfaces:**
- Consumes: native Agent CLI, standalone Hono server, and Electron-only desktop from Tasks 1, 3, and 4.
- Produces: `pnpm dev` starts workspace scripts for `@agent3d/agent`, `@agent3d/server`, and `@agent3d/desktop` in parallel. Each package also has direct `dev`, `test`, `typecheck`, and `build` commands.

- [ ] **Step 1: Write failing workspace smoke assertions**

Update `workspace-smoke.test.mjs` to assert:

1. Root `dev` uses all three workspace filters.
2. Agent `dev` runs Mastra CLI and has `@mastra/ai-sdk`, `@mastra/core`, and compatible CLI dependencies.
3. Server has a root `.env`-loading dev entrypoint and explicit build/typecheck/test scripts.
4. Desktop dev no longer imports or starts the Hono app and has no backend-only dependencies.
5. `.env.example` documents stable loopback URLs/ports, separate Hono/Agent/broker tokens, renderer origin, mock mode, and optional data-directory override.

- [ ] **Step 2: Run the smoke test and confirm it fails**

Run: `pnpm exec node --test scripts/workspace-smoke.test.mjs`

Expected: current scripts still omit the server workspace and environment settings.

- [ ] **Step 3: Wire direct workspace commands and compatible runtime requirements**

Set the root `dev` filters to Agent, server, and desktop. Add the Hono server `dev` script using `--env-file-if-exists=../../.env`; use the Mastra CLI's default `src/mastra/index.ts` entry and load the root `.env` with Node's `--env-file-if-exists` option. Add the required server dev dependency (`tsx`), an emitting Node ESM server build script, and root engine floor `>=22.13.0`.

- [ ] **Step 4: Document setup and service boundaries**

Update `.env.example` with safe local placeholders and stable defaults: Hono `http://127.0.0.1:62586`, credential broker `http://127.0.0.1:62588`, Agent `http://127.0.0.1:62687`, renderer origin `http://localhost:5173`, distinct Hono/Agent/broker tokens, mock mode, and optional `AGENT3D_DATA_DIR`. Update `README.md` with the three-process diagram/flow, service ownership, environment setup, direct per-package commands, Agent native server/Studio URL, stream adaptation, and the limitation that packaged Electron does not supervise these services.

- [ ] **Step 5: Verify root workspace wiring**

Run: `pnpm exec node --test scripts/workspace-smoke.test.mjs`

Expected: all root and workspace topology assertions pass.

---

### Final verification

- [ ] Run `pnpm test`.

Expected: workspace smoke tests and all workspace test suites pass.

- [ ] Run `pnpm typecheck`.

Expected: all workspaces type-check, including dynamic request-context model/tool types.

- [ ] Run `pnpm build`.

Expected: Agent builds through the Mastra CLI, Hono builds independently, and Electron builds without bundling or importing Mastra.

- [ ] Start `pnpm dev` and verify all three service logs and listeners.

Expected: Mastra's native Agent server, Hono API, and Electron start independently; each listener is loopback-only. A chat request is visible at the Mastra server, a greeting remains a chat response, an explicit asset request yields a pending validated artifact, and a stopped Agent produces a retryable Hono error without data loss.
