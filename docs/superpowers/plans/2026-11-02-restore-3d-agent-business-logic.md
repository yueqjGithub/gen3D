# Restore the 3D Agent Business Logic

> **For the implementer:** After the user approves this plan, execute it using the execution workflow they choose: `subagent-driven-development` or `executing-plans`. Keep the work test-first.

**Goal:** Replace the generic starter implementation in `apps/agent` with the original 3D asset agent, using Mastra's native server and chat route while preserving the existing Hono-to-Agent contract.

**Architecture:** Keep `apps/agent` as a single Mastra application with one `asset-creation-agent`. Resolve each request's provider, model, base URL, and API key from the validated `requestContext` sent by Hono; never retain credentials or model selection in a global provider instance. The agent returns the shared structured `{ result: ... }` contract and streams reasoning through Mastra's native AI SDK v7 `chatRoute`. Hono remains responsible for attachments, persistence, approval, and user preferences. The agent proposes Blender scripts but does not execute them.

**Tech Stack:** TypeScript, Mastra 1.81, Mastra AI SDK v7 route, AI SDK v7 provider adapters, Zod 4, Vitest.

## Non-negotiable constraints

- Do not alter, remove, or add commands to the `scripts` object in `apps/agent/package.json`; keep `mastra dev`, `mastra build`, and `mastra start` unchanged.
- Put Agent-local configuration in `apps/agent/.env` and document it in `apps/agent/.env.example`. Do not modify the root `.env`.
- Use only the request-scoped model configuration provided by Hono; do not hardcode a model key or fall back to `AGNES_API_KEY` in Agent code.
- Do not add a second HTTP server. Expose the endpoint with Mastra's native `server` configuration and `chatRoute`.
- Preserve the existing Hono API, streaming format, structured-output contract, and tools' IDs.
- Do not execute generated scripts or images as part of the Agent implementation.

## Contract and design decisions

- Agent ID and route: `asset-creation-agent` at `/chat/:agentId`.
- Native route: Mastra `chatRoute`, AI SDK v7 stream format, reasoning enabled.
- The final structured result is `AgentOutput` wrapped as `{ result: AgentOutput }`, with `type: 'chat' | 'asset'`.
- Use the `AgentChatRequestContext` schema in `packages/shared/src/agent-service.ts`; reject missing or malformed context instead of silently defaulting to a fixed model.
- Support the provider protocols present in Hono's provider catalog: OpenAI-compatible and Anthropic. Keep provider URL, credentials, and model ID request-scoped. Preserve the full model ID for OpenAI-compatible providers; normalize provider-qualified IDs where the Anthropic adapter expects the upstream ID.
- The Agent may return chat for greetings, ambiguous messages, or attachment-only requests; asset output requires clear generation intent. Hono remains authoritative for inline-image model capability checks and must reject unsupported image requests before calling the Agent.
- Keep `analyze-input`, `build-asset-brief`, `generate-blender-script`, and `update-preferences` compatible with Hono's stream parser. Preference changes are suggestions for Hono to persist, not direct Agent storage writes.
- Bind the native server to loopback, use the configured Agent port, and require the same `AGENT3D_AGENT_TOKEN` that Hono sends. Remove only generic starter capabilities unrelated to this application.

## File map

- Modify `apps/agent/package.json`: add only required runtime/test dependencies; leave `scripts` byte-for-byte unchanged.
- Modify `pnpm-lock.yaml`: update the workspace lockfile using pnpm after dependency changes.
- Add `apps/agent/src/mastra/agent-context.ts` and its test: validate and type the request-scoped model, conversation, and preference context.
- Add `apps/agent/src/mastra/model-adapter.ts` and its test: create an AI SDK model from the current request context without caching credentials or configuration.
- Add `apps/agent/src/mastra/tools/`: implement the four Hono-compatible tools and tests, including validation for generated Blender script content.
- Replace `apps/agent/src/mastra/agents/agent.ts` and add agent tests: implement the structured 3D asset agent, generation-intent guidance, attachment-aware context handling, and request-scoped model selection.
- Replace `apps/agent/src/mastra/index.ts` and add server/middleware tests: register only the application agent, configure Mastra's native loopback server and `chatRoute`, validate its service token/context, and avoid duplicate request-context sources.
- Add `apps/agent/.env.example`; update `apps/agent/.env` only to add Agent-local runtime settings if needed, preserving existing contents and secret values. Never read or print secret values.
- Update the relevant root README section to explain the Mastra-native Agent, Agent-local environment configuration, matching service token, and unchanged workspace commands.
- Update `scripts/workspace-smoke.test.mjs` to assert the approved Agent scripts and Agent-local environment contract without requiring new script commands.

## Implementation tasks

## Task 1: Add request-scoped context and model resolution

1. Add the required direct dependencies to the Agent workspace: `@agent3d/shared`, `@mastra/ai-sdk`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, and Vitest for tests. Use pnpm to resolve compatible versions and update the lockfile; do not change scripts.
2. Write failing unit tests for valid/missing/malformed request context and model resolution before adding production implementations.
3. Implement context parsing against the shared schema, including the selected model, conversation data, attachments, and preferences needed by the prompt/tools.
4. Implement request-scoped model construction for the catalog's supported protocols. Reject unsupported protocols or missing required model configuration with explicit errors. Ensure two concurrent contexts cannot reuse each other's URL, model ID, or key.
5. Test that the adapter constructs models without making network calls and that credentials never appear in thrown messages or logs.

## Task 2: Implement tools and structured 3D agent behavior

1. Write failing tool and Agent behavior tests using deterministic mock models.
2. Implement the four stable tool IDs consumed by Hono:
   - `analyze-input`: summarize the user's explicit request and available attachment metadata.
   - `build-asset-brief`: build a bounded, typed 3D brief only after clear asset-generation intent.
   - `generate-blender-script`: return a Blender script proposal and validate its shape/content; never execute it.
   - `update-preferences`: emit a typed preference suggestion for Hono to persist.
3. Replace the generic template prompt and tools with a concise Chinese-first 3D assistant prompt. The model must answer greetings and ambiguous requests conversationally and must not invoke generation tools merely because a file is attached.
4. Configure structured output to match `AgentOutput` and `{ result: AgentOutput }`, keeping all tool IDs, output part names, and fields compatible with Hono.
5. Test greeting, ambiguous intent, attachment-only input, explicit generation intent, script validation, and preference suggestions.

## Task 3: Restore Mastra-native server and service authentication

1. Write failing tests for the service-token boundary, invalid `requestContext`, and one request-scoped chat request before changing the server setup.
2. Remove generic starter registrations (filesystem/sandbox, schedules, unrelated memory/observability, and generic tools) from Agent registration; retain only capabilities required by this application.
3. Configure the native Mastra server on `127.0.0.1` with the configured Agent port and `chatRoute({ path: '/chat/:agentId', version: 'v7', sendReasoning: true })`. Do not add Hono or another HTTP server inside `apps/agent`.
4. Require the internal service token and validate the Hono-provided request context before handing off to `chatRoute`. Ensure only one request-context source is passed to the route to prevent the previous “Multiple requestContext sources provided” warning.
5. Add an Agent-local `.env.example` with the port and service token, update the existing ignored `apps/agent/.env` only if a required Agent-local setting is missing, and leave the root `.env` untouched. Do not copy, display, or log credential values.
6. Test unauthorized requests, malformed service payloads, and authorized requests without calling a real provider.

## Task 4: Document and validate the end-to-end contract

1. Update the relevant README setup and architecture sections; keep all existing run commands accurate and do not recommend adding an Agent HTTP service.
2. Update `scripts/workspace-smoke.test.mjs` to verify the required Agent scripts and Agent-local env contract without adding or changing Agent script commands.
3. Run focused Agent tests with `pnpm --filter @agent3d/agent exec vitest run src/mastra`.
4. Run Agent type checking directly without editing its scripts: `pnpm --filter @agent3d/agent exec tsc --noEmit -p tsconfig.json`.
5. Run workspace regression checks: `pnpm test` and `pnpm typecheck`.
6. Run the existing Agent build command, `pnpm --filter @agent3d/agent build`. If Mastra's bundler still fails only while parsing the pnpm 12 multi-document lockfile, report that exact failure separately; do not downgrade pnpm or rewrite the lockfile manually.
7. Verify with a local mock provider that Hono-to-Mastra SSE works end-to-end: greeting, ambiguous message, and attachment-only request return `chat`; clear asset-generation intent returns `asset`; Hono receives the compatible tool/structured-output events and creates a pending approval rather than executing the script.
8. Review the final diff to confirm `apps/agent/package.json` scripts are unchanged and the root `.env` has no changes.

## Review focus

- No asset generation on greetings, ambiguous requests, or attachment-only requests.
- Model URL, ID, protocol, and credentials are selected per request and never leak between concurrent requests.
- Missing/invalid internal auth or request context fails explicitly and never falls back to default credentials.
- Mastra owns the Agent HTTP route; no duplicate server or duplicate `requestContext` source is introduced.
- Hono's stable tool IDs, structured-output shape, and SSE expectations remain unchanged.
- User secrets are neither printed nor moved to the root `.env`.
