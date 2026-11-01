import { describe, expect, it } from 'vitest';
import { createWindowOwner } from './window-owner';

describe('main window ownership', () => {
  it('retainsTheWindowUntilItCloses', () => {
    let onClosed: (() => void) | undefined;
    const window = {
      on(event: 'closed', listener: () => void) {
        expect(event).toBe('closed');
        onClosed = listener;
      },
    };
    const owner = createWindowOwner<typeof window>();

    owner.retain(window);
    expect(owner.current).toBe(window);
    onClosed?.();
    expect(owner.current).toBeNull();
  });
});
