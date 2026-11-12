import { Hono } from 'hono';
import { z } from 'zod';
import { conversationSchema } from '@agent3d/shared';
import type { AttachmentStore } from '../storage/attachments';
import type { createConversationRepository } from '../storage/conversations';
import { HttpError } from '../http-errors';
import { getCookie } from 'hono/cookie';

type ConversationRepository = ReturnType<typeof createConversationRepository>;

export interface ConversationRouteDependencies {
  conversations: ConversationRepository;
  attachments: AttachmentStore;
}

const createConversationRequestSchema = z.object({
  title: conversationSchema.shape.title.optional(),
}).strict();
const renameConversationRequestSchema = z.object({
  title: conversationSchema.shape.title,
}).strict();

/** 会话管理：列表、创建、重命名、删除，以及读取某个会话的历史消息。 */
export function createConversationRoutes({
  conversations,
  attachments,
}: ConversationRouteDependencies) {
  const routes = new Hono();

  routes.get('/conversations', (context) => context.json({ conversations: conversations.list(getCookie(context, 'username')!) }));

  routes.post('/conversations', async (context) => {
    const body = createConversationRequestSchema.parse(await context.req.json());
    return context.json({ conversation: conversations.create(body.title ?? 'New conversation', getCookie(context, 'username')!) }, 201);
  });

  routes.get('/conversations/:id', (context) => {
    const conversation = conversations.get(context.req.param('id'), getCookie(context, 'username')!);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }
    return context.json({ conversation });
  });

  routes.patch('/conversations/:id', async (context) => {
    const body = renameConversationRequestSchema.parse(await context.req.json());
    const conversation = conversations.get(context.req.param('id'), getCookie(context, 'username')!);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }
    return context.json({
      conversation: conversations.rename(conversation.id, body.title, getCookie(context, 'username')!),
    });
  });

  routes.delete('/conversations/:id', async (context) => {
    const conversation = conversations.get(context.req.param('id'), getCookie(context, 'username')!);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }

    // 先删附件文件再删会话：会话删除会级联删除附件的数据库记录，之后就找不到文件路径了
    await attachments.deleteByConversation(conversation.id);
    conversations.delete(conversation.id, getCookie(context, 'username')!);
    return context.body(null, 204);
  });

  routes.get('/conversations/:id/messages', (context) => {
    const conversation = conversations.get(context.req.param('id'), getCookie(context, 'username')!);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }
    return context.json({ messages: conversations.listMessages(conversation.id) });
  });

  return routes;
}
