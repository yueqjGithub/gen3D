# Separate Mastra Service Design

## Intent

Separate the Mastra learning path from the Hono API so a learner can open and run the Agent project without tracing through HTTP gateway, Electron, and persistence code. Preserve the existing Electron experience while making the service boundary visible and simple.

## Goals

- Move Mastra Agent construction, prompts, tools, model adapters, Agent schemas, and Mastra stream handling into a dedicated `apps/agent` pnpm workspace project.
- Run the Mastra project as a standalone local HTTP service that can be started and tested independently.
- Keep Hono as the single API used by the React renderer for conversations, uploads, settings, and asset approval.
- Make Hono call the Agent service over loopback HTTP for model generation; Hono remains responsible for authorization, attachment ownership/storage, persistence, and AI SDK UI stream conversion.
- Remove all direct Mastra imports and Agent construction from the Electron app and Hono routes.
- Update the root `README.md` with the new architecture, per-service responsibilities, run commands, and a learner-friendly reading path.

## Non-goals

- Do not redesign the UI, shared chat contracts, conversation persistence, asset review workflow, or model settings.
- Do not let the renderer call the Agent service directly.
- Do not add a database or user/session persistence to the Agent service.
- Do not introduce a general RPC framework, containers, or broad dependency-injection abstractions.

## Approaches

- **Hono gateway → standalone Agent HTTP service (chosen):** Hono keeps the current application-facing API and data/security responsibilities, and sends a small, explicit request to `apps/agent`. This isolates the Mastra learning project without changing renderer contracts.
- **Renderer → both services:** The React app calls Hono for product data and Agent for chat. This exposes Agent service details and two stream/auth lifecycles to the UI, increasing coupling in the client.

The chosen approach follows the user's preference for clear, traceable project boundaries. The root development command starts the Agent service and Electron/Hono client as separate workspace processes; Electron itself must not construct or manage Mastra.

## Workspace and ownership

- `apps/agent` owns Mastra dependencies and code: agent factory, tools, prompt, model adapter, model-specific request schema, Agent service HTTP entrypoint, and Mastra stream serialization.
- `apps/server` owns Hono routes, attachment/document retrieval and preprocessing, provider/model/key resolution, conversation and artifact persistence, preference storage, and conversion from Agent service events to the AI SDK UI message stream.
- `apps/desktop` owns Electron, safe credential storage, local SQLite/repositories, and the renderer. It starts Hono as it does today and does not import Mastra or Agent implementation files.
- `packages/shared` owns contracts that cross project boundaries, including the Agent service request and stream event envelope, plus the small pure Blender script validator used by both Agent generation and Hono approval. Mastra-specific internal schemas remain in `apps/agent`.

## Service contract and data flow

1. The renderer continues to send its current authorized request to Hono.
2. Hono validates the turn, reads only attachments owned by the conversation, extracts document text, loads saved preferences, resolves the model and credential, and constructs an Agent request.
3. Hono calls the Agent service over HTTP on `127.0.0.1`. The request carries the selected model configuration, API key, messages, prepared attachment context, preferences, and the request cancellation signal. The API key must never be logged or included in stream output.
4. The Agent service creates the request-scoped Mastra model/Agent, streams Mastra chunks as newline-delimited JSON events, and sends one final validated structured result. The contract must distinguish stream chunks from the final result and preserve errors without exposing provider response bodies or credentials.
5. Hono translates Agent events into the existing AI SDK UI message stream, persists the turn, and creates a pending asset only for an asset-generation result.
6. Cancellation from the renderer must cancel the Hono-to-Agent request and the upstream Mastra stream.

The Agent service binds only to loopback. Hono-to-Agent authentication is internal and must not be exposed to the renderer. The Agent service does not persist data. Request DTOs and event DTOs must be explicit, bounded, and validated at the HTTP boundary.

## Development and runtime

- Keep the Agent service independently runnable with `pnpm --filter @agent3d/agent dev`.
- Keep the Hono/Electron development entrypoint and configure root `pnpm dev` to run the Agent and desktop workspace `dev` scripts in parallel.
- Do not add a custom process launcher or readiness protocol; each workspace application retains its own direct run command.
- Use an explicit local Agent base URL/port from environment configuration, with loopback-only binding. Document how to start Agent and Hono separately for debugging.
- The desktop production main process must not import or instantiate Mastra. Document the Agent service as a runtime prerequisite unless a later packaging requirement explicitly asks for a bundled Agent process.

## Compatibility and security

- Preserve renderer-visible `/api` endpoints and AI SDK UI message chunks.
- Preserve request-scoped provider credentials and the current secret-storage flow; secrets may cross only the local Hono-to-Agent request boundary.
- Never log Agent request bodies, model API keys, attachment contents, or provider error bodies.
- Keep existing local-origin and random renderer-token protection on Hono. Bind Agent only to `127.0.0.1` and require an internal service token not exposed by preload or renderer.
- Keep user-provided attachments local; Hono sends only extracted text and supported inline image data to Agent.
- Keep static Blender script validation before persistence and the existing user approval requirement. The shared validator is used by Agent generation and Hono persistence/approval so this rule has one implementation.

## README changes

Rewrite the architecture overview to show three separate responsibilities: Electron/React client, Hono API gateway, and standalone Mastra Agent service. Add exact commands for running Agent independently, running the desktop stack, testing/typechecking/building each workspace, and tracing a greeting through a conversational Agent response. Replace the old learning-path step that locates Agent source under `apps/server/src/agent` with paths under `apps/agent`.

## Acceptance criteria

- `apps/agent` is a pnpm workspace project and can start its standalone loopback service independently.
- Electron and Hono source files do not import `@mastra/core` or Agent implementation files.
- Hono delegates generation over the explicit Agent HTTP contract and preserves cancellation, stream errors, reasoning/tool events, and final output.
- Existing UI/API, attachment, persistence, retry, approval, mock, and security tests remain valid; new tests cover service contract validation and Hono-to-Agent streaming.
- Root `pnpm dev`, `pnpm test`, `pnpm typecheck`, and `pnpm build` work with the separated projects.
- `README.md` accurately describes current startup dependencies, service boundaries, environment configuration, and learning path.
