const running = new Set<string>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T | { skipped: true }> {
  if (running.has(key)) return { skipped: true };
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}
