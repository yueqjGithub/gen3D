import { z } from 'zod';

/** Agent 提议写入用户长期偏好的单条建议；保存前必须由用户确认。 */
export const preferenceProposalSchema = z.object({
  key: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  value: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
}).strict();

/** Agent 在普通聊天模式下返回的回复。 */
export const chatAgentOutputSchema = z.object({
  type: z.literal('chat'),
  reply: z.string().trim().min(1).max(4000),
}).strict();

/** Agent 在明确的资产创建请求下返回的 Blender 生成结果。 */
export const assetGenerationOutputSchema = z.object({
  type: z.literal('asset'),
  brief: z.string().trim().min(1).max(4000),
  script: z.string().trim().min(1).max(100 * 1024),
  blenderVersion: z.literal('4.x'),
  preferenceProposals: z.array(preferenceProposalSchema).max(10),
}).strict();

/** Agent 需要在普通聊天与资产生成两种结果之间明确选择。 */
export const agentOutputSchema = z.discriminatedUnion('type', [
  chatAgentOutputSchema,
  assetGenerationOutputSchema,
]);

/** Mastra 使用的单对象结构化输出封装，避免顶层联合类型与其输出泛型冲突。 */
export const agentStructuredOutputSchema = z.object({
  result: agentOutputSchema,
}).strict();

/** 持久化的 Blender 资产及其当前版本、审批状态和脚本内容。 */
export const assetArtifactSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  version: z.number().int().positive(),
  brief: z.string().trim().min(1).max(4000),
  script: z.string().min(1).max(100 * 1024),
  blenderVersion: z.literal('4.x'),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.iso.datetime(),
}).strict();

/** 资产审批请求携带的预期版本，用于拒绝对过期版本的审批。 */
export const artifactApprovalSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

/** 通过 `preferenceProposalSchema` 校验后的用户偏好建议类型。 */
export type PreferenceProposal = z.infer<typeof preferenceProposalSchema>;
/** 通过 `agentOutputSchema` 校验后的普通聊天或资产生成结果类型。 */
export type AgentOutput = z.infer<typeof agentOutputSchema>;
/** 通过 `agentStructuredOutputSchema` 校验后的 Mastra 输出封装类型。 */
export type AgentStructuredOutput = z.infer<typeof agentStructuredOutputSchema>;
/** 通过 `assetGenerationOutputSchema` 校验后的资产生成结果类型。 */
export type AssetGenerationOutput = z.infer<typeof assetGenerationOutputSchema>;
/** 通过 `assetArtifactSchema` 校验后的持久化资产类型。 */
export type AssetArtifact = z.infer<typeof assetArtifactSchema>;
/** 通过 `artifactApprovalSchema` 校验后的审批请求类型。 */
export type ArtifactApproval = z.infer<typeof artifactApprovalSchema>;
