/** The visitor's DeepSeek API key, kept in this browser only. */
const DEEPSEEK_KEY = 'ready-prompt.deepseek-key';

/** Listeners for key changes (the panel shows whether one is saved). */
export const keyListeners: (() => void)[] = [];

export function getDeepSeekKey(): string | null {
  try {
    return localStorage.getItem(DEEPSEEK_KEY);
  } catch {
    return null;
  }
}

export function setDeepSeekKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(DEEPSEEK_KEY, key);
    else localStorage.removeItem(DEEPSEEK_KEY);
  } catch {
    /* storage blocked: the key lasts for this call only */
  }
  for (const f of keyListeners) f();
}
