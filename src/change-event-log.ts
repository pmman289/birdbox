import type { ChangeEvent } from "../packages/contracts/src/api.js";

const MAX_EVENT_MESSAGE_LENGTH = 8192;

export class ChangeEventLog {
  readonly #events: ChangeEvent[] = [];

  add(level: string, message: unknown, nodeId: string | null = null): ChangeEvent {
    const fullMessage = String(message ?? "");
    const boundedMessage = fullMessage.length > MAX_EVENT_MESSAGE_LENGTH
      ? `${fullMessage.slice(0, MAX_EVENT_MESSAGE_LENGTH)}\n...消息已截断`
      : fullMessage;
    const entry = { timestamp: new Date().toISOString(), level, message: boundedMessage, nodeId };
    if (this.#events.length >= 100) this.#events.splice(0, this.#events.length - 99);
    this.#events.push(entry);
    return entry;
  }

  list(): ChangeEvent[] {
    return this.#events;
  }
}
