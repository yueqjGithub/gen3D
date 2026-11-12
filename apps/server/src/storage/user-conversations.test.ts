import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestDirectory } from '../test-directory';
import { createDatabase } from './database';
import { createConversationRepository } from './conversations';
import { createPreferenceRepository } from './preferences';

it('stores Mastra threads and messages under the user who created them', async () => {
  const database = await createDatabase(join(createTestDirectory('user-conversations-'), 'test.sqlite'));
  try {
    database.connection.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('alice', 'a');
    database.connection.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('bob', 'b');
    const conversations = createConversationRepository(database.connection);
    const alice = conversations.create('Alice thread', 'alice');
    conversations.create('Bob thread', 'bob');
    conversations.appendMessage({
      id: randomUUID(), conversationId: alice.id, role: 'user',
      parts: [{ type: 'text', text: 'Hello' }], createdAt: new Date().toISOString(), status: 'complete',
    });

    expect(conversations.list('alice').map(({ id }) => id)).toEqual([alice.id]);
    expect(conversations.get(alice.id, 'bob')).toBeNull();
    expect(database.connection.prepare('SELECT resourceId FROM mastra_messages WHERE thread_id = ?')
      .get(alice.id)).toEqual({ resourceId: 'alice' });
  } finally {
    database.close();
  }
});

it('keeps preferences separate for each user', async () => {
  const database = await createDatabase(join(createTestDirectory('user-preferences-'), 'test.sqlite'));
  try {
    database.connection.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('alice', 'a');
    database.connection.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('bob', 'b');
    const preferences = createPreferenceRepository(database.connection);
    preferences.upsert('style', 'wood', 'alice');
    preferences.upsert('style', 'metal', 'bob');
    expect(preferences.list('alice')).toEqual({ style: 'wood' });
    expect(preferences.list('bob')).toEqual({ style: 'metal' });
  } finally {
    database.close();
  }
});
