export const KERNEL_POLICY_TIMEOUT_MS = 5000;
export const FRONTEND_POLICY_TIMEOUT_MS = 10000;

export class PolicySyncTimeoutError extends Error {
  constructor() {
    super("策略同步超时，结果未确认；请勿自动重试写入");
    this.name = "PolicySyncTimeoutError";
  }
}

export class PolicySyncBlockedError extends Error {
  constructor() {
    super("上次策略请求尚未结束，暂不接受新的策略读写");
    this.name = "PolicySyncBlockedError";
  }
}

export interface PolicyTask {
  check(): void;
  wait<T>(action: () => Promise<T>): Promise<T>;
}

/** A deadline ends the caller's wait, not the host request or its write ownership. */
export class PolicyTaskQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  constructor(private readonly timeoutMs: number) {}

  run<T>(action: (task: PolicyTask) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ended = true;
        reject(new PolicySyncTimeoutError());
      }, this.timeoutMs);
    });
    const check = () => {
      if (ended || Date.now() >= deadline) throw new PolicySyncTimeoutError();
    };
    const task: PolicyTask = {
      check,
      wait: async <V>(start: () => Promise<V>): Promise<V> => {
        check();
        this.inFlight += 1;
        const request = Promise.resolve().then(() => {
          check();
          return start();
        }).finally(() => { this.inFlight -= 1; });
        const value = await Promise.race([request, timeout]);
        check();
        return value;
      },
    };
    const pending = this.tail.then(async () => {
      check();
      if (this.inFlight > 0) throw new PolicySyncBlockedError();
      return action(task);
    });
    this.tail = pending.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const settle = (finish: () => void) => {
        settled = true;
        clearTimeout(timer!);
        finish();
      };
      pending.then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      );
      timeout.catch(() => {
        // The deadline fired. The action's own classified failure arrives as
        // microtasks and settles this promise first; the raw timeout escapes
        // only when the action truly never settles.
        setTimeout(() => {
          if (!settled) reject(new PolicySyncTimeoutError());
        }, 0);
      });
    });
  }
}
