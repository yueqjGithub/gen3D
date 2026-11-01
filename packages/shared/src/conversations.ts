import { z } from 'zod';
import { preferenceProposalSchema } from './agent';

/** 会话列表和会话详情使用的持久化数据结构。 */
export const conversationSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

/**
 * 持久化聊天消息的内容部件联合类型。
 * 使用应用自有的中立格式，避免把数据库历史绑定到某个 AI SDK 版本。
 */
export const persistedMessagePartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('reasoning'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('tool-activity'),
    toolName: z.string().min(1).max(100),
    state: z.enum(['input-streaming', 'input-available', 'output-available', 'error']),
    summary: z.string().max(1000).optional(),
  }).strict(),
  z.object({
    type: z.literal('attachment'),
    attachmentId: z.uuid(),
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(100),
  }).strict(),
  z.object({
    type: z.literal('asset'),
    artifactId: z.uuid(),
  }).strict(),
  z.object({
    type: z.literal('preference-proposal'),
    proposal: preferenceProposalSchema,
  }).strict(),
]);

/** SQLite/API 中的一条完整聊天消息，包含角色、内容、时间和完成状态。 */
export const chatMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  parts: z.array(persistedMessagePartSchema),
  createdAt: z.iso.datetime(),
  status: z.enum(['complete', 'error']),
}).strict();

/** 通过 `conversationSchema` 校验后的会话类型。 */
export type Conversation = z.infer<typeof conversationSchema>;
/** 可保存到消息历史中的文本、推理、工具、附件、资产或偏好建议部件。 */
export type PersistedMessagePart = z.infer<typeof persistedMessagePartSchema>;
/** 通过 `chatMessageSchema` 校验后的持久化消息类型。 */
export type ChatMessage = z.infer<typeof chatMessageSchema>;
