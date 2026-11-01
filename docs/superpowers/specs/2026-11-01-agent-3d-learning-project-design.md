# Agent 3D Learning Project Design

## Intent

Build a complete, runnable learning project for a TypeScript frontend developer moving into agent development. The project should teach how an Electron desktop client, a Hono API, Mastra agents, model providers, streaming chat, persistence, and human approval fit together in one practical product.

The product helps a single user turn an image, a document, or a chat description into an editable 3D asset proposal. Its first milestone is a Blender 4.x-compatible agent-generated Python script and accompanying asset brief, with static checks but no in-app execution. A later milestone can execute the script with Blender and export GLB; the initial project must not claim to generate production 3D models through an unavailable provider.

## Goals

- Use pnpm v12 workspaces for a TypeScript monorepo; use the Node runtime managed by pnpm and do not rely on npm.
- Build the desktop client with Electron, electron-vite, and React.
- Target Windows for first-milestone development and acceptance; do not promise macOS/Linux packaging validation in that milestone.
- Use Hono for the local backend and Mastra for agent orchestration.
- Provide streaming chat through Vercel AI SDK `useChat`, including visible reasoning when the configured provider makes it available.
- Support image, document, and text inputs; keep the original input associated with its conversation.
- Persist conversation lists, messages, and user preference memory in local SQLite.
- Support retryable failures, model configuration, and human-in-the-loop approval before accepting or exporting generated scripts.
- Make agent behavior, tool boundaries, prompt composition, and state transitions understandable to a TypeScript learner through concise, useful code comments and project documentation.
- Keep secrets out of source control and make the app usable with the user's locally configured model credentials.

## Non-goals

- Multi-user accounts, cloud sync, hosted deployment, or team collaboration.
- Automatically executing generated Blender scripts or arbitrary code.
- Claiming native image-to-3D generation. Agnes image generation is an optional image-generation model, not a 3D model provider.
- Requiring Blender to be installed for the first milestone.
- Providing API keys for non-Agnes model providers.

## User experience and behavior

- The main workspace has a conversation sidebar, a streaming chat/agent activity area, an attachment composer, and an asset result panel.
- Users can create, reopen, rename, and delete local conversations.
- The composer accepts text, images, and supported documents; the agent can ask follow-up questions when requirements are underspecified.
- Agent progress and any provider-supplied reasoning are shown separately from the final response. Reasoning is not fabricated when the provider does not expose it.
- The result panel presents a concise asset brief and generated Blender Python script. Users can inspect and edit the script, then explicitly approve or reject it. Downloading the script is user-triggered; script execution is outside the first milestone.
- Failed requests expose an understandable error and a retry action without silently creating a successful-looking response.
- Settings allow selecting a chat model and image model, editing provider/base URL/model ID and credentials, and choosing defaults. Agnes chat (`agnes/agnes-3.0-flash`) and image (`agnes-image-2.5-flash`) are the initial defaults. Other provider choices can be listed with empty credentials and clear setup instructions.
- User preference memory is local, inspectable, and editable. The agent may propose a preference update, but only confirmed preferences are persisted.

## Architecture

Use the selected single-backend monorepo route:

- `apps/desktop`: Electron main/preload and React renderer, scaffolded with electron-vite's React template.
- `apps/server`: Hono local API hosting Mastra and the AI SDK-compatible streaming endpoint; the server stays on the user's machine.
- `packages/shared`: shared, runtime-validated request/response and domain types used by the desktop and server.
- `packages/*` may be introduced only where they clarify real boundaries, such as persistence or agent orchestration; avoid splitting the backend into independently deployed services.

The renderer communicates with the local Hono API and receives streamed assistant events. Provider credentials are never bundled into the renderer. Store secrets in a local, ignored configuration file or operating-system secure storage, and document the chosen implementation and its tradeoffs. Do not write credentials to logs, SQLite, templates, or source control. The supplied credential must not be copied into project files.

SQLite is the initial source of truth for conversations, messages, and explicit user preferences. Attachments are kept in an app-local data directory with metadata in SQLite; define deletion behavior so deleting a conversation also handles its associated files. Validate file types and sizes and return clear errors for unsupported input.

The agent should use typed Mastra tools for input analysis, asset brief generation, and script generation. Separate analysis and final output clearly. Human approval is a server-validated state transition: only an explicitly approved script can be marked accepted or downloaded as the approved artifact. Generated code is data and must never be executed by the server.

## Model/provider handling

- Configure chat and image providers independently, with Agnes values prefilled as defaults and credentials supplied only by the user at runtime.
- Other model options are presets with blank credentials; unsupported providers must produce clear configuration errors rather than silent fallbacks.
- Local image bytes may be sent only as inline data to providers explicitly marked as supporting that format. Agnes 2.5 Flash documents publicly accessible image URLs, not local inline data, so its default selection must reject local image input rather than upload it or silently omit it.
- Keep provider selection and credential handling on the backend. The desktop settings UI should send updates over a local protected API and mask saved credentials.
- Use Vercel AI SDK streaming and `useChat` for the renderer. Confirm the selected Mastra/AI SDK integration supports the requested stream protocol; adapt at the server boundary rather than creating a second client streaming implementation.
- Image generation is an optional agent/tool capability, distinct from 3D asset generation.

## Reliability, safety, and accessibility

- Make retry behavior explicit and avoid duplicate persisted turns on retry.
- Handle aborted streams, server startup failures, missing keys, provider errors, and malformed uploads with visible errors.
- Bind the local server to loopback only and restrict access to the local desktop app as feasible; do not expose credentials in client-visible responses.
- Use keyboard-accessible controls, visible focus, and clear loading/error/approval states.
- Comments should explain non-obvious boundaries, state transitions, and agent/tool decisions. Avoid comments that merely restate code.

## Learning and documentation

Include a root README that explains prerequisites, pnpm workspace commands, environment setup without real secrets, how to run/test/build, architecture, agent and tool flows, SQLite persistence, stream lifecycle, human approval, and a staged learning path. Add focused comments at important extension points and explain the security boundary around generated Blender scripts.

## Approaches considered

1. **Electron + one Hono backend hosting Mastra (selected).** Provides clear desktop/API/agent boundaries and the requested Hono and Mastra learning experience without introducing multi-service operations.
2. **Separate Hono gateway and Mastra service.** Offers stronger deployment separation but adds network and deployment complexity that does not benefit this single-user, local-first learning MVP.
3. **Embed the agent in Electron's main process.** Simplifies process count but weakens separation of UI, model credentials, persistence, and backend concerns, and omits the requested Hono learning surface.

The selected route is local-first with SQLite, and the 3D deliverable starts as an editable Blender script and asset brief. Actual Blender execution and GLB export remain a deliberate later milestone.

## Decisions left to the builder

- Choose compatible, maintained package versions and the smallest practical workspace tooling.
- Select SQLite and migration/access libraries that work reliably with the chosen Electron/Node versions.
- Choose a secure local credential storage approach that is practical for development and document it clearly.
- Define the initial set of additional provider presets, supported document formats and upload limits.
- Implement typed streaming and reasoning display in a way compatible with current AI SDK and Mastra APIs.
- Add tests around critical behaviors: persistence, retries, model configuration, file validation, approval transitions, and agent output shape.
- Provide mock/test mode so core flows and UI can be verified without a real provider key.
- Verify generated scripts target Blender 4.x syntax and structure without executing them in the application; real Blender execution and export remain later work.
- Validate the first milestone on Windows; other platform packaging is out of scope.
