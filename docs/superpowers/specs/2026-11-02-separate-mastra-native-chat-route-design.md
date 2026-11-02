# Mastra Native Server and Standalone Hono Design

## Intent

Correct the local development topology so `pnpm dev` clearly starts three real
processes: the Mastra Agent server, the Hono application API, and the Electron
desktop client. Use Mastra's native server and AI SDK chat route rather than a
hand-written Agent HTTP listener.

The project is a learning workspace for a frontend developer moving into Agent
development. Its architecture should make the Mastra server and Agent execution
visible and traceable, while keeping desktop persistence and local credentials
behind the Hono API.

## Current state

- `apps/agent/src/http.ts` implements a custom Node HTTP listener for health,
  token authentication, request validation, abort propagation, and NDJSON.
- `apps/agent/src/runner.ts` does call Mastra's `agent.stream()`; the service is
  not an empty listener, but its transport is custom instead of Mastra's native
  server.
- `apps/desktop/src/main/index.ts` creates the Hono app, SQLite repositories,
  Electron `safeStorage` credential store, and Hono listener in the Electron
  main process.
- Root `pnpm dev` starts only the Agent workspace and Electron. Hono is hidden
  inside Electron, so it is not an independently visible workspace service.
- The Hono routes resolve the selected provider and credentials per turn,
  prepare local attachments and preferences, persist conversations and assets,
  and approve/download generated scripts.
- The renderer calls only Hono and receives no Agent-service token or provider
  key.

## Goals

1. Make Agent, Hono server, and Electron separate processes in local development.
2. Use Mastra's generated server with `server` configuration and the
   `@mastra/ai-sdk` `chatRoute()` API.
3. Keep Hono as the only renderer-facing API and retain its ownership of local
   attachment access, model selection/credential resolution, persistence,
   Blender validation, and approval.
4. Preserve request-specific model configuration and prepared document, image,
   and preference context without exposing secrets to the renderer.
5. Keep UI-configured model credentials encrypted using Electron `safeStorage`
   through a narrowly scoped, authenticated loopback credential broker.
6. Make `pnpm dev` start `@agent3d/agent`, `@agent3d/server`, and
   `@agent3d/desktop` using workspace scripts, without adding a launcher or
   readiness polling.
7. Preserve safe stream cancellation, error handling, and asset persistence
   behavior.

## Non-goals

- Automatically starting or supervising backend services in a packaged
  Electron build. This change guarantees the local `pnpm dev` workflow only.
- Replacing Hono's public API with Mastra's API or allowing the renderer to call
  Mastra directly.
- Moving conversation, attachment, or asset persistence into Mastra storage.
- Adding a new image-generation request workflow.
- Adding a custom process launcher, readiness polling, or a service supervisor.

## Anti-goals

- Do not retain the hand-written Agent HTTP listener alongside the Mastra
  server.
- Do not put model API keys, attachment contents, conversation history, or
  preference values in logs.
- Do not expose Agent or credential-broker ports/tokens to the renderer.
- Do not accept client-supplied provider credentials or unvalidated
  `requestContext` data from renderer requests.
- Do not relax loopback binding or authentication to make cross-process
  development easier.

## Approaches considered

### A. Mastra native server with a custom `registerApiRoute()`

Use the native server for the service boundary but keep a custom route that
accepts the current AgentService DTO and serializes the existing NDJSON event
contract. This is the least disruptive to Hono but keeps a project-specific
stream protocol and requires custom stream conversion.

### B. Mastra native server with `@mastra/ai-sdk` `chatRoute()` — selected

Use `chatRoute()` as the Agent endpoint and Mastra's AI SDK UI-message stream.
Hono will send only server-prepared messages and request context, consume the
Mastra UI stream, validate the structured output, persist valid assets, and
produce the existing renderer-facing UI stream.

This best matches the requested Mastra-native learning path. The current model
configuration is request-specific, so the registered Agent must resolve its
model dynamically from a schema-validated request context. Tools must read
documents, images, and preferences from the same per-request context instead of
capturing those values at Agent construction time.

### C. Call Mastra directly from the renderer

This would remove the Hono proxy but would expose the Agent boundary and require
renderer-visible authentication and result handling. It conflicts with the
existing security and persistence responsibilities and is rejected.

## Decisions

- `apps/agent` will export a Mastra instance with server configuration, register
  the Asset Agent and `chatRoute({ path: '/chat/:agentId', sendReasoning: true,
  version: 'v7' })`, and be started using the compatible Mastra CLI development
  command.
- The Agent server binds only to `127.0.0.1`. CORS is disabled or restricted to
  the Hono origin; the renderer never calls it.
- The Agent endpoint requires the internal Agent service token. Hono is the
  trusted caller and constructs all request context after validating user input,
  reading attachments from its own store, and resolving the selected model and
  credential.
- Mastra's structured output is returned as the chat route's structured-output
  data part. Hono must require exactly one valid final structured result before
  completing a turn or persisting an asset. A chat result never creates an
  asset.
- The Agent model is selected dynamically per execution from validated
  `requestContext` model information. Hono remains responsible for model
  catalog validation and API-key resolution.
- Hono owns SQLite, attachments, preferences, conversations, and assets. The
  independent Hono process obtains credentials through a loopback-only broker
  hosted by Electron main. The broker performs only credential get/set/delete
  operations via Electron `safeStorage`; its authentication secret and endpoint
  are shared between the local processes and are not passed to renderer code.
- Electron main becomes the desktop client and credential-broker host; it no
  longer creates the Hono app or its database repositories.
- Root `pnpm dev` runs Agent, Hono server, and Electron scripts concurrently
  through pnpm filters. Startup readiness is not coordinated; API calls made
  before dependencies bind must fail explicitly and be retryable.
- The Hono API token is configured for the local development processes and is
  passed to renderer through preload. Agent and credential-broker tokens remain
  main/server-process-only.
- Hono database and attachment paths must remain stable across process
  separation. The implementation plan must determine a deterministic
  `AGENT3D_DATA_DIR` default compatible with the existing Electron user-data
  location, and preserve existing local data when changing ownership.

## Request and stream flow

1. Electron renderer sends a chat request to the Hono API using the existing
   renderer token.
2. Hono authenticates the renderer, checks the conversation and attachment
   ownership, prepares document/image context, resolves model configuration
   and credentials, and builds the Mastra `requestContext`.
3. Hono sends the full validated message history and trusted request context to
   the Mastra `chatRoute()` endpoint with the internal Agent token.
4. The registered Mastra Agent resolves the request model and context, runs its
   tools, and streams AI SDK UI-message chunks, including reasoning and the
   final structured-output data part.
5. Hono converts the Agent stream to the renderer's existing UI stream. It
   rejects missing, duplicate, malformed, or invalid structured results and
   persists a pending asset only for a valid asset result and Blender script.
6. Renderer cancellation propagates to the Mastra request and aborts generation.
7. When UI settings save or remove an API key, Hono calls the Electron
   credential broker, which stores/removes it through `safeStorage`.

## Service startup and environment

- `.env.example` documents stable loopback URLs/ports, Hono renderer token,
  Agent internal token, credential-broker configuration, mock mode, and the
  data directory. Values are safe local-development placeholders.
- `apps/agent` has explicit `dev`, `test`, `typecheck`, and `build` scripts;
  `dev` starts Mastra's native server and loads the repository root `.env`.
- `apps/server` gains an explicit development entrypoint and script. It binds to
  loopback, loads the same root `.env`, owns the local database, and connects to
  the Agent and credential broker.
- `apps/desktop` continues to run Electron/Vite and reads the root `.env`.
- Root `pnpm dev` runs all three package scripts in parallel and does not add
  custom orchestration.
- README documents the three-process topology, service ownership, environment
  setup, direct per-package commands, and a traceable chat flow.

## Security and failure behavior

- All three service listeners bind to loopback only.
- Hono-to-Agent and Hono-to-credential-broker requests use separate internal
  tokens and bounded request schemas.
- Only Hono can resolve the model selection, credentials, conversation history,
  and attachment data; the renderer cannot choose arbitrary `requestContext`
  fields.
- Agent and broker failures return generic safe errors. No request bodies,
  model keys, attachment content, or upstream provider response bodies are
  logged.
- A failed/incomplete Agent stream does not persist an assistant success or an
  asset. A valid asset result is still pending user approval before download.
- Electron startup is not blocked by Agent readiness; Hono reports upstream
  unavailability explicitly so the user can retry after services start.

## Verification expectations

- Agent tests exercise the real Mastra `chatRoute()` with a test Agent/provider
  or a deterministic injected model, including request-context model selection,
  attachments/preferences reaching tools, reasoning output, structured output,
  auth rejection, and cancellation.
- Hono integration tests cover the actual AI SDK stream parser/adapter,
  renderer-visible stream compatibility, invalid or missing structured output,
  stream error/cancellation, and no persistence on failure.
- Credential-broker tests cover authentication, safeStorage encryption/decryption,
  missing credentials, deletion, and safe error responses.
- Server startup tests confirm loopback binding and independent database
  lifecycle.
- Workspace smoke tests assert the three root `dev` filters and all direct
  service scripts.
- Full `pnpm test`, `pnpm typecheck`, and `pnpm build` pass; desktop output does
  not bundle Mastra; Agent uses its native server command.

## Open implementation checks for the builder

- Confirm compatible `@mastra/ai-sdk` and Mastra CLI versions against the
  installed `@mastra/core` version and installed AI SDK v7 before adding them.
- Confirm how the installed `chatRoute()` accepts trusted `requestContext` and
  which final structured-output stream data shape Hono should parse.
- Confirm the most reliable way to keep the existing Electron user-data and
  attachment paths stable when Hono owns the database in its own process.
- Keep any implementation-level choices that do not alter these behaviors
  simple and consistent with existing workspace scripts and tests.
