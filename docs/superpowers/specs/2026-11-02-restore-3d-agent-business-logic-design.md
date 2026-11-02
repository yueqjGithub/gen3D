# Restore 3D Agent Business Logic

## Intent

Rebuild the business-facing Mastra implementation in `apps/agent` after the workspace was reset to a generic Mastra starter template. The Agent should again serve the existing 3D asset learning application through its existing Hono-to-Agent contract, while the implementation remains understandable as a small Mastra project.

## Goals

- Register the existing `asset-creation-agent` with Mastra's native server and AI SDK v7 `chatRoute`.
- Preserve the current Hono request/response contract and stream reasoning, tool activity, one validated structured result, and completion chunks.
- Use the model selected for the current turn. Hono supplies the validated model ID, protocol, API key, images, extracted documents, saved preferences, and conversation messages through the internal request.
- Produce a `chat` result for greetings, discussion, ambiguous intent, or attachment-only turns; produce an `asset` result only for an explicit creation request.
- Restore focused input-analysis, asset-brief, Blender-script validation, and preference-proposal tools.
- Keep generated scripts as text and statically validate them; never execute generated code.
- Preserve the product's human approvals: assets remain pending in Hono until the user approves/rejects them, and preference proposals are applied only after user confirmation.
- Support deterministic mock mode through the same Agent service contract.
- Keep service credentials and Agent-only configuration in `apps/agent/.env`; do not modify the root `.env`.
- Do not change any command in `apps/agent/package.json`'s `scripts` object.

## Non-goals

- Do not change the Electron UI, Hono API contract, chat persistence, attachment storage/extraction, provider catalog, or asset approval flow.
- Do not retain generic starter-template workspace/shell tools, recurring schedules, generic task tools, or an unrelated observational-memory model.
- Do not add a second HTTP framework or a custom Agent HTTP server; use Mastra's native server.
- Do not add a separate image-generation request pipeline. Uploaded images remain reference inputs to chat models that support inline images.
- Do not expose provider credentials, attachment bodies, or unfiltered provider errors in logs or streamed UI data.
- Do not modify the root `.env` or `apps/agent/package.json` scripts.

## Approaches

1. **One structured 3D Agent (chosen):** One Mastra Agent selects the `chat` or `asset` branch of the existing structured-output contract. It receives each turn's selected model and context, uses a small set of domain tools, and streams through the native `chatRoute`. This preserves Hono/UI behavior and keeps the learning path direct.
2. **Separate chat and generation agents/workflow:** A routing Agent or workflow delegates to a conversation Agent or asset-generation Agent. This separates responsibilities, but adds orchestration and changes the existing single-Agent contract without a current product need.

The user selected the single-Agent approach and requested removing unrelated starter-template functionality.

## Existing boundaries to preserve

- `apps/server` remains the renderer-facing Hono gateway and owns model/key resolution, attachment preparation, persistence, preferences, and approval state.
- `apps/server/src/agent-client.ts` posts UI messages and a trusted `requestContext.agent3d` object to the loopback Agent endpoint. The Agent's dynamic configuration must consume this request context rather than a process-global model.
- Hono's `prepareConversationInput()` rejects image attachments before creating an Agent request when the selected provider does not support inline images; the Agent must not silently omit image input.
- `packages/shared/src/agent-service.ts` defines bounded service and request-context contracts. `packages/shared/src/agent.ts` defines the `chat | asset` result and asset/preference shapes. The Agent must validate these at its boundary and return exactly one structured result.
- `apps/server/src/streaming/agent-ui-stream.ts` recognizes the domain tools `analyze-input`, `build-asset-brief`, `generate-blender-script`, and `update-preferences`; preserve these IDs unless implementation evidence requires an explicit coordinated change.
- Hono owns the user-facing Human-in-the-loop transitions. Agent tools may propose outputs but must not approve or persist them.

## Intended implementation

- Keep Mastra's native `chatRoute` at `/chat/:agentId`, with the registered Agent ID `asset-creation-agent`, AI SDK v7 formatting, and reasoning enabled.
- Authenticate Hono-to-Agent requests with the existing internal token and bind the native service to `127.0.0.1`. Validate the body context before using it. Avoid duplicate request-context sources by ensuring the native route receives its context from only one source.
- Build the selected provider model per request from the trusted request context. Support the protocols already accepted by Hono (`openai-compatible` and `anthropic`); fail explicitly for unsupported provider/model combinations. Do not rely on a global API key or mutable Agent model state.
- Define a structured output wrapper matching `{ result: AgentOutput }`, where `AgentOutput` is the shared discriminated `chat | asset` schema. The prompt must make explicit creation intent the condition for asset output and must treat greetings, uncertain requests, and attachment-only turns as conversation.
- Keep the business tools focused and request-scoped. The analysis/brief tools should receive current attachments and saved preferences only. The script tool should return a Blender 4.x script and apply the shared static validator. The preference tool may produce proposals but cannot mutate Hono state.
- Provide deterministic test-model behavior for mock mode without changing the app's public contract or requiring an external model key.
- Remove imports and registrations for starter-only workspace, schedule, and memory features from the Agent implementation. Retain only infrastructure needed by the native route and model adapters.
- Preserve the existing `apps/agent/package.json` `dev`, `build`, and `start` script commands exactly. Add or adjust runtime dependencies only where required by direct imports, using pnpm and the existing workspace conventions.
- Keep Agent-specific variables in `apps/agent/.env`; add an `apps/agent/.env.example` if useful for documenting the port/token contract. The Agent token must match the existing Hono client token, but the root `.env` is not to be edited.
- Update the relevant README statements and learning-path file references so they describe the restored Agent layout and distinguish Agent-local configuration from Hono's existing root configuration.

## Validation

- Add/restore tests before implementation for: authenticated native route and context propagation; mock greeting/ambiguous/attachment-only turns staying in `chat`; explicit creation yielding one validated `asset`; request-scoped model selection; attachment/preference context isolation; static rejection of unsafe scripts; and native stream completion.
- Run Agent tests and typecheck, then full `pnpm test` and `pnpm typecheck`.
- Run `pnpm --filter @agent3d/agent build` without altering its script. Record any verified pre-existing Mastra CLI/pnpm lockfile incompatibility separately; do not rewrite the lockfile or change the script as a workaround.
- Verify the actual Hono-to-Mastra path with mock mode when the local services can be started without changing the root `.env`.
