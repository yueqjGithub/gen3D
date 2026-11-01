interface ClosableWindow {
  on(event: 'closed', listener: () => void): unknown;
}

export function createWindowOwner<Window extends ClosableWindow>() {
  let current: Window | null = null;

  return {
    get current(): Window | null {
      return current;
    },
    retain(window: Window): void {
      current = window;
      window.on('closed', () => {
        if (current === window) {
          current = null;
        }
      });
    },
  };
}
