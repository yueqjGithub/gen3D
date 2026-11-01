# Agent 3D Learning Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first, local Electron learning app that uses a Mastra agent to turn chat, images, and documents into reviewable Blender 4.x scripts, with streamed responses, local sessions, preference memory, provider settings, and explicit human approval.

**Architecture:** A pnpm monorepo contains an Electron/electron-vite React client and a Hono API hosted locally by the Electron main process. The API composes Mastra agents, AI SDK UI stream responses, SQLite persistence, and injected credential/attachment stores; shared Zod contracts define the client/server boundary. Blender scripts remain text artifacts: users review and approve before download, and the app never executes them.

**Tech Stack:** pnpm workspaces, TypeScript, Electron, electron-vite, React, Sass, Hono, Mastra, Vercel AI SDK (`ai`, `@ai-sdk/react`), Zod, SQLite (`better-sqlite3`), Vitest, electron safeStorage.

**Spec:** `docs/superpowers/specs/2026-11-01-agent-3d-learning-project-design.md`

## Global Constraints

- “Use pnpm v12 workspaces for a TypeScript monorepo; use the Node runtime managed by pnpm and do not rely on npm.”
- “Build the desktop client with Electron, electron-vite, and React.”
- “Use Hono for the local backend and Mastra for agent orchestration.”
- “Target Windows for first-milestone development and acceptance; do not promise macOS/Linux packaging validation in that milestone.”
- “Use Vercel AI SDK streaming and `useChat` for the renderer.”
- “Agnes chat (`agnes/agnes-3.0-flash`) and image (`agnes-image-2.5-flash`) are the initial defaults.”
- “The result panel presents a concise asset brief and generated Blender Python script.”
- “Users can inspect and edit the script, then explicitly approve or reject it.”
- “Generated code is data and must never be executed by the server.”
- “SQLite is the initial source of truth for conversations, messages, and explicit user preferences.”
- “The supplied credential must not be copied into project files.”
- “Comments should explain non-obvious boundaries, state transitions, and agent/tool decisions. Avoid comments that merely restate code.”

## Review Focus

1. **Missing, corrupt, or locked credential storage:** settings and chat must surface a recoverable configuration error without exposing key material. Test encrypted credential round-trips and unavailable safeStorage behavior in Task 4.
2. **Unsupported, oversized, or malformed attachments:** reject with a typed client-visible error and leave conversation state consistent. Test extension/MIME mismatch, upload limits, and malformed PDF in Task 6.
3. **Interrupted, failed, or retried streams:** persist one user turn and one final assistant turn, do not duplicate on retry, and show retryable errors. Test abort, provider failure, and retry semantics in Task 6.
4. **Stale or forged human approval:** only the pending script/version shown to the user can be approved; rejected or edited artifacts must not become accepted implicitly. Test approve/reject/edit/version changes in Task 7.
5. **Unsafe or malformed generated script:** enforce the output schema and bounded static checks, never execute the script, and clearly warn before download. Test malformed output and suspicious calls such as `exec`, `eval`, `subprocess`, and `os.system` in Task 5.

---

### Task 1: Create the pnpm monorepo and desktop shell

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/main.tsx`
- Create: `apps/desktop/src/renderer/src/App.tsx`
- Create: `apps/desktop/src/renderer/src/styles.scss`
- Test: `scripts/workspace-smoke.test.mjs`

**Interfaces:**
- Workspace package names are `@agent3d/desktop`, `@agent3d/server`, and `@agent3d/shared`; `packageManager` pins the selected pnpm 12 release.
- Produces root scripts `pnpm dev`, `pnpm build`, `pnpm test`, and `pnpm typecheck`.
- Produces an Electron window loading the React renderer and a context-isolated preload with no unrestricted Node access.
- Uses Sass for styling. Do not add Tailwind unless implementation demonstrates a concrete need.

- [ ] **Step 1: Write `scripts/workspace-smoke.test.mjs`** with Node's built-in test runner to assert pnpm workspace metadata, root scripts, and renderer entry presence.
- [ ] **Step 2: Run `pnpm exec node --test scripts/workspace-smoke.test.mjs`** and confirm it fails because the workspace files do not exist.
- [ ] **Step 3: Scaffold the root and Electron React shell** with electron-vite's React template conventions, pnpm workspaces, TypeScript strict mode, Sass, and a minimal app window. Use pnpm only.
- [ ] **Step 4: Run `pnpm install` and `pnpm --filter desktop build`**; confirm the workspace resolves and the Electron renderer/main bundles compile on Windows.
- [ ] **Step 5: Run `pnpm typecheck`** and confirm all initial packages pass.

### Task 2: Define shared contracts and validation

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/conversations.ts`
- Create: `packages/shared/src/attachments.ts`
- Create: `packages/shared/src/models.ts`
- Create: `packages/shared/src/agent.ts`
- Create: `packages/shared/src/errors.ts`
- Test: `packages/shared/src/*.test.ts`

**Interfaces:**
- Package name is `@agent3d/shared`; its `test` script runs Vitest against the package tests.
- `Conversation`: `{ id: string; title: string; createdAt: string; updatedAt: string }`.
- `PersistedMessagePart` is a discriminated union for text, reasoning, tool activity, attachment, and asset references; translate it to/from AI SDK `UIMessage` parts at the client/server boundary rather than importing AI SDK types into the shared package.
- `ChatMessage`: `{ id: string; conversationId: string; role: 'user' | 'assistant'; parts: PersistedMessagePart[]; createdAt: string; status: 'complete' | 'error' }`.
- `ModelConfig`: `{ providerId: string; modelId: string; baseURL: string; apiKeyConfigured: boolean }`; `ModelSelection` contains independent `chat` and `image` configs. Never include a credential in a response type.
- `AssetArtifact`: `{ id: string; conversationId: string; version: number; brief: string; script: string; blenderVersion: '4.x'; status: 'pending' | 'approved' | 'rejected'; createdAt: string }`.
- Expose Zod schemas and inferred types for conversation, upload metadata, model configuration, agent output, artifact approval, and typed API errors.
- Initial upload allowlist: PNG/JPEG/WebP images and PDF/Markdown/plain-text documents; reject all others. Set a 10 MiB per-file limit and 20 MiB per-conversation aggregate attachment limit.

- [ ] **Step 1: Write schema tests** named `acceptsModelSettingsWithoutCredentialValues`, `rejectsInvalidIdsAndMimeTypes`, `enforcesPerFileAndAggregateLimits`, `validatesAgentOutput`, and `serializesTypedErrors`.
- [ ] **Step 2: Run `pnpm --filter @agent3d/shared test`** and confirm the new schema tests fail.
- [ ] **Step 3: Implement the Zod schemas and exported inferred types** in the listed files.
- [ ] **Step 4: Run the shared test suite** and confirm each accepted/rejected input matches the contract.

### Task 3: Implement SQLite persistence and attachment storage

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/src/storage/database.ts`
- Create: `apps/server/src/storage/migrations/001-initial.sql`
- Create: `apps/server/src/storage/conversations.ts`
- Create: `apps/server/src/storage/preferences.ts`
- Create: `apps/server/src/storage/artifacts.ts`
- Create: `apps/server/src/storage/attachments.ts`
- Test: `apps/server/src/storage/*.test.ts`

**Interfaces:**
- Package name is `@agent3d/server`; native SQLite loading is tested in the Electron/Node runtimes used by the app.
- `createDatabase(path: string): DatabaseHandle`; initialize migrations idempotently and enable SQLite foreign keys.
- `ConversationRepository`: `list()`, `create(title)`, `get(id)`, `rename(id, title)`, `delete(id)`, `appendMessage(message)`, `listMessages(id)`.
- `PreferenceRepository`: `list()`, `upsert(key, value)`, `delete(key)`.
- `ArtifactRepository`: `createPending(input)`, `get(id)`, `updatePending(id, expectedVersion, script)`, `setStatus(id, expectedVersion, status)`.
- `AttachmentStore`: save validated upload bytes under Electron `userData`, return opaque metadata, read by ID, and delete by conversation; never use a user-supplied path.

- [ ] **Step 1: Write repository tests** named `migrationIsIdempotent`, `conversationCrudPreservesMessageOrder`, `deleteConversationCleansRelatedData`, `preferenceRepositoryPersistsExplicitValues`, `artifactUpdateRequiresExpectedVersion`, and `attachmentStoreRejectsPathTraversal`.
- [ ] **Step 2: Run the targeted storage tests** and confirm failures before implementation.
- [ ] **Step 3: Implement the SQLite schema and repositories** with parameterized queries and transactionally consistent conversation deletion.
- [ ] **Step 4: Run the storage tests** and confirm data survives closing/reopening a temporary database.

### Task 4: Add local configuration, secure credentials, and provider resolution

**Files:**
- Create: `apps/desktop/src/main/credentials.ts`
- Create: `apps/server/src/config/provider-catalog.ts`
- Create: `apps/server/src/config/model-resolver.ts`
- Create: `apps/server/src/config/settings-repository.ts`
- Create: `apps/server/src/config/env.ts`
- Create: `apps/server/src/storage/migrations/002-settings.sql`
- Test: `apps/server/src/config/*.test.ts`
- Test: `apps/desktop/src/main/credentials.test.ts`

**Interfaces:**
- `CredentialStore`: `get(providerId): Promise<string | null>`, `set(providerId, secret): Promise<void>`, `delete(providerId): Promise<void>`.
- Electron implementation uses `safeStorage` and stores only encrypted credential blobs in Electron `userData`; if encryption is unavailable, refuse to persist secrets and tell the user to configure environment variables for development.
- Settings repository persists provider/model/baseURL and non-secret settings in SQLite; API reads return only `apiKeyConfigured`.
- Provider catalog includes Agnes chat `agnes/agnes-3.0-flash` and image `agnes-image-2.5-flash` defaults, plus a small list of OpenAI-compatible and Anthropic presets with blank credentials.
- Settings keep chat and image model selections independent; the image selection is used by the provider-ready image-generation capability only if that capability is enabled, and must never silently affect chat.
- Provider resolver creates request-scoped model inputs from selected settings and secrets using the installed Mastra version's documented custom-provider configuration; do not mutate process-global environment variables per request. Missing credentials or unsupported providers return typed errors, never default silently.
- Agnes chat uses `https://apihub.agnes-ai.com/v1` as the default OpenAI-compatible base URL; do not place a real API key in templates, tests, logs, or repository files.

- [ ] **Step 1: Write provider and credential tests** named `usesAgnesDefaultsForIndependentModels`, `refusesCredentialPersistenceWhenSafeStorageUnavailable`, `storesCredentialsEncryptedAndReadsBack`, `neverReturnsCredentialValues`, `rejectsUnknownProviders`, and `reportsMissingCredentials`.
- [ ] **Step 2: Run config tests** and confirm missing implementations fail.
- [ ] **Step 3: Implement Electron safeStorage and backend provider resolution** behind the interfaces; inject dependencies so tests use in-memory fakes.
- [ ] **Step 4: Run config tests** and verify no serialized response or log contains a credential.

### Task 5: Build Mastra agent, tools, structured asset output, and static checks

**Files:**
- Create: `apps/server/src/agent/mastra.ts`
- Create: `apps/server/src/agent/asset-agent.ts`
- Create: `apps/server/src/agent/model-adapter.ts`
- Create: `apps/server/src/agent/tools/analyze-input.ts`
- Create: `apps/server/src/agent/extract-document.ts`
- Create: `apps/server/src/agent/tools/build-asset-brief.ts`
- Create: `apps/server/src/agent/tools/generate-blender-script.ts`
- Create: `apps/server/src/agent/tools/update-preferences.ts`
- Create: `apps/server/src/agent/validate-script.ts`
- Create: `apps/server/src/agent/prompts/asset-agent.ts`
- Test: `apps/server/src/agent/*.test.ts`

**Interfaces:**
- `createAssetAgent(deps: { model: MastraModelConfig; preferences: PreferenceRepository; attachments: AttachmentStore; supportsInlineImages: boolean }): Agent`; use the installed Mastra public type and request-scoped provider adapters without mutating process-global environment variables.
- Agent result schema: `{ brief: string; script: string; blenderVersion: '4.x'; preferenceProposals: Array<{ key: string; value: string; reason: string }> }`.
- `validateBlenderScript(script: string): { ok: true } | { ok: false; code: 'empty' | 'too_large' | 'missing_bpy' | 'blocked_pattern' }`.
- `extractDocument(input: { mediaType: string; bytes: Uint8Array }): Promise<{ text: string }>`; extract PDF text and decode Markdown/plain text within the shared file-size limit.
- Local image bytes are converted to an OpenAI-compatible `data:` image URL only for providers configured to accept image input; never upload user images to a public host. Agnes documents public image URLs but not inline data URLs, so its default chat selection rejects local image inputs; provider errors are surfaced rather than silently dropping the image.
- Extracted document context is bounded to 100,000 characters, with explicit errors instead of silent truncation.
- Apply a 100 KiB script limit, require `bpy` import, reject obvious execution/process-launch patterns, and never execute or claim that static checks prove Blender API compatibility.
- Preference proposals are written only after explicit user confirmation.

- [x] **Step 1: Write agent/output tests** named `returnsStructuredBlender4AssetResult`, `rejectsEmptyOrOversizedScripts`, `blocksDangerousExecutionPatterns`, `doesNotExecuteGeneratedScript`, and `persistsOnlyConfirmedPreferenceProposals`.
- [x] **Step 2: Run agent tests** with a deterministic fake model and verify they fail before implementation.
- [x] **Step 3: Implement Mastra agent/tools** and encode Blender 4.x expectations in the prompt and result contract. Add concise comments for non-obvious tool and trust boundaries.
- [x] **Step 4: Run the agent tests** and verify suspicious scripts are rejected as data without being executed.

### Task 6: Expose Hono API, streamed chat, uploads, retries, and approval transitions

**Files:**
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/routes/conversations.ts`
- Create: `apps/server/src/routes/chat.ts`
- Create: `apps/server/src/routes/attachments.ts`
- Create: `apps/server/src/routes/models.ts`
- Create: `apps/server/src/routes/artifacts.ts`
- Create: `apps/server/src/streaming/mastra-ui-stream.ts`
- Create: `apps/server/src/middleware/local-origin.ts`
- Test: `apps/server/src/routes/*.test.ts`

**Interfaces:**
- `createApp(deps: AppDependencies): Hono`; dependencies include repositories, attachment store, credential store, model resolver, and agent factory.
- Routes: `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/:id`, `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/attachments`, `POST /api/chat`, `GET/PATCH /api/models`, `PUT/DELETE /api/models/credentials/:providerId`, `GET/PUT/DELETE /api/preferences`, `POST /api/artifacts/:id/approve`, `POST /api/artifacts/:id/reject`, `PATCH /api/artifacts/:id`.
- Chat request is Zod-validated `{ conversationId, clientTurnId, messages: UIMessage[], attachmentIds: string[] }`; response is an AI SDK UI-message stream compatible with `DefaultChatTransport`.
- Persist the user turn once before the request; enforce uniqueness on `(conversationId, clientTurnId)`; persist the completed assistant turn once at stream finish; record a failure state without success-shaped fallback. Retry reuses `clientTurnId` and does not duplicate the user turn.
- Return provider-supplied reasoning as a distinct stream part only when the model exposes it; do not synthesize hidden chain-of-thought.
- Bind Hono to loopback in Electron main; verify allowed origin and a per-launch local token for API calls, and do not return secrets.
- Approval/rejection routes require the current pending artifact version. Editing increments version and returns the artifact to pending.
- Preference routes are `GET/PUT/DELETE /api/preferences`; agent suggestions are presented to the user and written only after an explicit `PUT` confirmation.

- [x] **Step 1: Write API tests** named `streamsAiSdkUiMessageParts`, `abortedStreamDoesNotPersistSuccess`, `retryReusesClientTurnId`, `rejectsMismatchedOrOversizedUploads`, `rejectsMalformedPdf`, `rejectsUntrustedOriginOrToken`, and `rejectsStaleArtifactApproval`.
- [x] **Step 2: Run route tests** and confirm the expected endpoints/stream handling are absent.
- [x] **Step 3: Implement Hono routes and Mastra-to-AI-SDK stream adapter** using the current documented Mastra `.stream()` chunks and AI SDK UI stream protocol.
- [x] **Step 4: Run route tests** with fake model/credential dependencies and confirm all failure states are explicit and retryable.

### Task 7: Build the React chat, session list, asset review, and settings UI

**Files:**
- Create: `apps/desktop/src/renderer/src/api/client.ts`
- Create: `apps/desktop/src/renderer/src/features/conversations/ConversationSidebar.tsx`
- Create: `apps/desktop/src/renderer/src/features/chat/ChatView.tsx`
- Create: `apps/desktop/src/renderer/src/features/chat/MessageParts.tsx`
- Create: `apps/desktop/src/renderer/src/features/chat/Composer.tsx`
- Create: `apps/desktop/src/renderer/src/features/assets/AssetPanel.tsx`
- Create: `apps/desktop/src/renderer/src/features/settings/ModelSettings.tsx`
- Create: `apps/desktop/src/renderer/src/features/settings/PreferenceSettings.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.scss`
- Test: `apps/desktop/src/renderer/src/features/**/*.test.tsx`

**Interfaces:**
- `useChat` uses `DefaultChatTransport` with the local `/api/chat` endpoint and sends conversation and attachment IDs as transport metadata.
- Chat renders text, reasoning, tool/activity, error, and approval/artifact parts distinctly. Retry uses AI SDK retry/regenerate behavior only when the backend contract guarantees idempotency.
- Sidebar lists, creates, renames, opens, and deletes SQLite-backed sessions.
- Composer supports image/document selection and displays attachment validation/progress/errors.
- Asset panel displays brief, Blender 4.x target, editable script, static-check result, approve/reject controls, and an explicit script download action.
- Settings supports independent chat and image provider/model/base URL selection, password-masked API key entry, and key removal; server responses never repopulate the secret.
- Preference memory has a local inspect/edit/delete view, and proposed preference updates require user confirmation.

- [ ] **Step 1: Write component tests** named `switchesBetweenPersistedConversations`, `rendersStreamingAndReasoningParts`, `showsAttachmentValidationErrors`, `retriesFailedTurnWithoutDuplicate`, `requiresApprovalForEditedArtifactVersion`, `masksSavedCredentials`, and `confirmsPreferenceProposalsExplicitly`.
- [ ] **Step 2: Run the targeted renderer tests** and confirm the behaviors fail before the UI exists.
- [ ] **Step 3: Implement the React features** with Sass layouts and keyboard-accessible controls; explain only non-obvious state/stream boundaries in comments.
- [ ] **Step 4: Run renderer tests and `pnpm typecheck`**; verify app view remains usable at narrow window widths.

### Task 8: Integrate Electron startup, Windows build, mock mode, and learning documentation

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `package.json`
- Create: `apps/server/src/dev.ts`
- Create: `apps/server/src/testing/mock-model.ts`
- Create: `README.md`
- Create: `.env.example`
- Create: `apps/server/.env.example`
- Test: `apps/server/src/testing/*.test.ts`

**Interfaces:**
- Electron main initializes user data directories, encrypted credential store, SQLite, Hono API, and renderer with a loopback-only random port and per-launch token.
- Preload exposes only the local API base URL and per-launch token through `contextBridge`; renderer code cannot access unrestricted Node/Electron APIs.
- Development server uses environment variables or mock model credentials; production must not depend on `.env` files.
- The Agnes multimodal adapter converts local image bytes to an inline `data:` URL for a vision-capable OpenAI-compatible model; tests assert the image is neither omitted nor sent to a public host.
- Mock mode generates deterministic chat, reasoning/tool activity, and a valid Blender 4.x script so all main flows can be demonstrated without a real key.
- Root README documents Node/pnpm prerequisites, setup without real secrets, run/build/test commands, architecture, stream lifecycle, Mastra agent/tool flow, persistence, approval, static script limits, and a staged learning path.
- User-facing errors explain missing credentials and provider failures without exposing provider response bodies or keys.

- [ ] **Step 1: Write startup and mock-mode tests** named `bindsOnlyToLoopback`, `rejectsRequestsWithoutLaunchToken`, `closesLocalServerOnAppExit`, and `completesMockConversationAndApprovalFlow`.
- [ ] **Step 2: Run integration tests** and confirm app startup and mock journey are not yet wired.
- [ ] **Step 3: Connect Electron main to Hono and secure storage; add mock mode and README** with explicit Windows-first instructions.
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, and `pnpm build`**; verify all pass on Windows.
- [ ] **Step 5: Run the app in mock mode** and manually verify create conversation → attach supported file → stream response → inspect/edit/approve script → download → reopen conversation.
- [ ] **Step 6: Inspect repository files and logs** to confirm no API key or secret value is present.

## Implementation Notes

- Do not add a package until its compatibility with the chosen Electron/Node versions is confirmed.
- If an API shown in Mastra or AI SDK docs changes, adapt only the provider/stream boundary; keep the shared contracts and tests stable. Use Mastra's public model input type and verify custom base URL support rather than assuming a raw Vercel `LanguageModel` is accepted.
- Every user-facing error path should be explicit; do not silently fall back to a different provider, successful empty response, or default credential.
- Never execute generated Blender scripts in tests, Hono, or Electron.
