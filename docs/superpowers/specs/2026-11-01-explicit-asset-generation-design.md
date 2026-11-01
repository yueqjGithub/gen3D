# Explicit Asset Generation Design

## Intent

Prevent ordinary messages such as “你好” from creating 3D assets. Generate an asset only when the user clearly asks to create one; keep normal chat conversational.

## Goals and non-goals

- Return a normal assistant response, with no pending artifact, for greetings and non-generation questions.
- Generate and persist a Blender asset only for clear creation requests.
- When a user sends only an image or document, ask whether they want an asset created from it.
- Keep the existing review-before-approval workflow for generated scripts.
- Do not add a separate conversational model or deterministic keyword classifier.

## Approaches

- **Prompt-only change:** Small, but the current required asset-shaped output and unconditional persistence still encourage artifact generation.
- **Discriminated chat/asset output (chosen):** Have the existing agent return either a conversational reply or an asset result. The server persists/emits an artifact only for the asset result. This directly prevents accidental artifact creation while reusing the existing model and stream.
- **Separate router and asset agents:** Strong separation, but adds an extra model step and more orchestration than this behavior change needs.

## Behavior and constraints

- The agent instructions must distinguish explicit creation intent from greetings, general questions, and ambiguous requests.
- Ambiguous intent should receive a focused clarification rather than an invented asset.
- An attachment without text should prompt the user to confirm asset creation.
- The server must describe attachment-only turns neutrally; it must not turn them into an instruction to create an asset.
- Extend the shared structured output with distinct chat and asset variants. Only the asset variant contains a Blender script and preference proposals.
- The chat route must branch on the output variant: both variants produce and persist assistant text, but only the asset variant creates an artifact, emits asset data, and emits preference proposals.
- Keep reasoning/tool stream behavior and existing asset validation and approval behavior intact.

## Acceptance criteria

- “你好” yields a conversational assistant message and creates no artifact.
- A general 3D-related question does not create an artifact unless the user clearly asks for creation.
- An attachment-only turn asks whether to create an asset and creates none yet.
- A clear asset-generation request creates one validated pending artifact.
- Existing retry, persistence, streaming, and approval behavior remains covered by tests.
