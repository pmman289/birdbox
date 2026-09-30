import type { AuditEventRecord, StateDatabase } from "./database.js";
import { errorContext, logger } from "./logger.js";

const MAX_COUNTERS = 500;
const MAX_AUDIT_TEXT = 512;

function safeText(value: unknown, limit = MAX_AUDIT_TEXT): string | null {
  if (value === null || value === undefined) return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) || null;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", '\\"').replaceAll("\n", "\\n");
}

interface Counter {
  method: string;
  route: string;
  statusClass: string;
  count: number;
}

/** Small dependency-free Prometheus registry for controller health metrics. */
export class MetricsRegistry {
  readonly #counters = new Map<string, Counter>();
  #requestCount = 0;
  #requestDurationSeconds = 0;

  observeRequest(method: string, route: string, status: number, durationMs: number): void {
    this.#requestCount += 1;
    this.#requestDurationSeconds += Math.max(0, durationMs) / 1000;
    const statusClass = `${Math.floor(status / 100)}xx`;
    const normalizedMethod = method.toUpperCase().slice(0, 16);
    const normalizedRoute = route.slice(0, 160) || "unknown";
    const key = `${normalizedMethod}\n${normalizedRoute}\n${statusClass}`;
    const existing = this.#counters.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.#counters.size >= MAX_COUNTERS) return;
    this.#counters.set(key, { method: normalizedMethod, route: normalizedRoute, statusClass, count: 1 });
  }

  render(): string {
    const lines = [
      "# HELP birdbox_http_requests_total Total HTTP requests handled by Birdbox.",
      "# TYPE birdbox_http_requests_total counter",
      ...[...this.#counters.values()].map((counter) =>
        `birdbox_http_requests_total{method="${escapeLabel(counter.method)}",route="${escapeLabel(counter.route)}",status_class="${counter.statusClass}"} ${counter.count}`),
      "# HELP birdbox_http_request_duration_seconds_sum Sum of HTTP request durations in seconds.",
      "# TYPE birdbox_http_request_duration_seconds_sum counter",
      `birdbox_http_request_duration_seconds_sum ${this.#requestDurationSeconds.toFixed(6)}`,
      "# HELP birdbox_http_requests_in_memory_total Total HTTP requests represented by this process.",
      "# TYPE birdbox_http_requests_in_memory_total counter",
      `birdbox_http_requests_in_memory_total ${this.#requestCount}`,
      "",
    ];
    return lines.join("\n");
  }
}

/** Serializes audit writes so a slow MySQL connection never blocks a response. */
export class AuditWriter {
  readonly #database: StateDatabase;
  #queue: Promise<void> = Promise.resolve();

  constructor(database: StateDatabase) {
    this.#database = database;
  }

  record(input: Omit<AuditEventRecord, "occurredAt"> & { occurredAt?: string }): void {
    const event: AuditEventRecord = {
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      requestId: safeText(input.requestId, 64) ?? "unknown",
      actor: input.actor,
      method: safeText(input.method, 16) ?? "UNKNOWN",
      path: safeText(input.path, 255) ?? "/",
      status: Number.isSafeInteger(input.status) ? input.status : 500,
      outcome: input.outcome,
      remoteAddress: safeText(input.remoteAddress, 128),
      userAgent: safeText(input.userAgent, 512),
      detail: safeText(input.detail, MAX_AUDIT_TEXT),
    };
    this.#queue = this.#queue
      .then(() => this.#database.appendAuditEvent(event))
      .catch((error) => {
        // Audit persistence must not take down request handling, but its loss
        // must remain visible to operators.
        logger.error("持久审计写入失败", errorContext(error));
      });
  }

  async flush(): Promise<void> {
    await this.#queue;
  }
}

