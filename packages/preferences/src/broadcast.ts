/**
 * Cross-tab notification (architecture section 9): after a commit, other tabs
 * are notified so they can revalidate. Uses BroadcastChannel when available
 * and degrades to a local no-op in non-browser contexts.
 */
import type { PreferenceKey } from "@ui-intelligence/protocol";

const CHANNEL_NAME = "ui-intelligence-preferences";

type MessageHandler = (key: PreferenceKey) => void;

function isPreferenceKey(value: unknown): value is PreferenceKey {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.profileId === "string" &&
    typeof v.projectId === "string" &&
    (v.scope === "app" || v.scope === "page" || v.scope === "entity" || v.scope === "instance") &&
    typeof v.scopeKey === "string"
  );
}

export class PreferenceBroadcast {
  #channel: BroadcastChannel | null;
  #handlers = new Set<MessageHandler>();

  constructor() {
    const ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (typeof ctor === "function") {
      this.#channel = new ctor(CHANNEL_NAME);
      this.#channel.onmessage = (event: MessageEvent) => {
        if (!isPreferenceKey(event.data)) return;
        for (const handler of this.#handlers) handler(event.data);
      };
    } else {
      this.#channel = null;
    }
  }

  /**
   * Notify a commit: posts to other tabs via BroadcastChannel. BroadcastChannel
   * does not echo to the sender, so local subscribers are invoked directly.
   */
  notifyCommit(key: PreferenceKey): void {
    this.#channel?.postMessage(key);
    for (const handler of this.#handlers) handler(key);
  }

  subscribe(handler: MessageHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  close(): void {
    this.#handlers.clear();
    this.#channel?.close();
    this.#channel = null;
  }
}
