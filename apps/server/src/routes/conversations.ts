import { Hono } from 'hono';
import { z } from 'zod';
import { conversationSchema } from '@agent3d/shared';
import type { AttachmentStore } from '../storage/attachments';
import type { createConversationRepository } from '../storage/conversations';
import { HttpError } from '../http-errors';

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

export function createConversationRoutes({
  conversations,
  attachments,
}: ConversationRouteDependencies) {
  const routes = new Hono();

  routes.get('/conversations', (context) => context.json({ conversations: conversations.list() }));

  routes.post('/conversations', async (context) => {
    const body = createConversationRequestSchema.parse(await context.req.json());
    return context.json({ conversation: conversations.create(body.title ?? 'New conversation') }, 201);
  });

  routes.get('/conversations/:id', (context) => {
    const conversation = conversations.get(context.req.param('id'));
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }
    return context.json({ conversation });
  });

  routes.patch('/conversations/:id', async (context) => {
    const body = renameConversationRequestSchema.parse(await context.req.json());
    const conversation = conversations.get(context.req.param('id'));
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }
    return context.json({
      conversation: conversations.rename(conversation.id, body.title),
    });
  });

  routes.delete('/conversations/:id', async (context) => {
    const conversation = conversations.get(context.req.param('id'));
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }

    // Remove attachment files before the conversation cascade deletes their metadata.
    await attachments.deleteByConversation(conversation.id);
    conversations.delete(conversation.id);
    return context.body(null, 204);
  });

  routes.get('/conversations/:id/messages', (context) => {
    const conversation = conversations.get(context.req.param('id'));
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }
    return context.json({ messages: conversations.listMessages(conversation.id) });
  });

  return routes;
}
