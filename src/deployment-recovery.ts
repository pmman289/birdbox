export type DeploymentRecoveryState = "idle" | "pending" | "failed";

export interface DeploymentRecoveryRunnerOptions {
  pending: boolean;
  recover(): Promise<void>;
  onStateChange?(state: DeploymentRecoveryState): void;
  onFailure?(error: unknown, retryInMs: number): void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?(delayMs: number): Promise<void>;
}

export interface DeploymentRecoveryRunner {
  readonly state: DeploymentRecoveryState;
  run(): Promise<void>;
  stop(): void;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

/**
 * Keeps startup recovery independent from HTTP availability. A pending journal
 * remains visible as a locked state until the remote replay has completed.
 */
export function createDeploymentRecoveryRunner(options: DeploymentRecoveryRunnerOptions): DeploymentRecoveryRunner {
  let currentState: DeploymentRecoveryState = options.pending ? "pending" : "idle";
  let stopped = false;
  let running: Promise<void> | null = null;
  const initialDelayMs = Math.max(1, Math.floor(options.initialDelayMs ?? 5_000));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(options.maxDelayMs ?? 300_000));
  const sleep = options.sleep ?? defaultSleep;

  const setState = (state: DeploymentRecoveryState): void => {
    currentState = state;
    options.onStateChange?.(state);
  };

  const run = async (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      if (!options.pending) {
        await options.recover();
        setState("idle");
        return;
      }

      let delayMs = initialDelayMs;
      while (!stopped) {
        try {
          await options.recover();
          setState("idle");
          return;
        } catch (error) {
          setState("failed");
          options.onFailure?.(error, delayMs);
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, maxDelayMs);
        }
      }
    })();
    return running;
  };

  return {
    get state() { return currentState; },
    run,
    stop() { stopped = true; },
  };
}
