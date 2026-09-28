import { RequestTimeoutError } from './errors';

/**
 * Rate and concurrency controls used by the client's shared RPC request queue.
 *
 * The queue is fair in that it respects both FIFO ordering and request priority:
 * requests are executed in strict FIFO order when they have the same priority.
 * When a request with higher priority is enqueued, it will be executed ahead of
 * lower-priority requests that are already queued, but after any requests that
 * were already being processed.
 */
export interface RequestQueueOptions {
  /** Maximum number of RPC requests in flight at once. Defaults to 4. */
  maxConcurrent?: number;
  /**
   * Maximum number of RPC requests started in any rolling one-second window. Defaults to 10.
   *
   * This enforces rate limiting at the RPC server level. High-priority requests
   * may still be delayed if the rate limit has been exhausted.
   */
  requestsPerSecond?: number;
}

/** Priority level for requests in the queue. Higher priority requests are processed first within FIFO ordering constraints. */
export enum RequestPriority {
  /** Low priority for background operations (e.g., UI polling). */
  Low = 0,
  /** Normal priority for regular operations. Default priority. */
  Normal = 1,
  /** High priority for user-initiated operations (e.g., form submissions). */
  High = 2,
}

interface PendingRequest<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  priority: RequestPriority;
  enqueuedAt: number;
}

/** FIFO queue that applies concurrency, rate, and timeout limits to asynchronous requests. */
export class RequestQueue {
  private readonly maxConcurrent: number;
  private readonly requestsPerSecond: number;
  private readonly pending: Array<PendingRequest<unknown>> = [];
  private readonly starts: number[] = [];
  private active = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RequestQueueOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.requestsPerSecond = options.requestsPerSecond ?? 10;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(this.requestsPerSecond) || this.requestsPerSecond < 1) {
      throw new RangeError('requestsPerSecond must be a positive integer');
    }
  }

  enqueue<T>(run: () => Promise<T>, timeoutMs?: number, signal?: AbortSignal, priority: RequestPriority = RequestPriority.Normal): Promise<T> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return Promise.reject(new RangeError('timeoutMs must be greater than zero'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest<T> = { run, resolve, reject, timeoutMs, signal, abortListener: undefined, priority, enqueuedAt: Date.now() };
      if (signal) {
        request.abortListener = () => {
          // Drop the request from the queue so an aborted request never runs.
          const index = this.pending.indexOf(request as PendingRequest<unknown>);
          if (index !== -1) this.pending.splice(index, 1);
          this.removeAbortListener(request);
          reject(signal.reason);
        };
        signal.addEventListener('abort', request.abortListener);
      }
      this.pending.push(request as PendingRequest<unknown>);
      this.drain();
    });
  }

  /**
   * Rejects every request that is queued but not yet started, clearing the
   * pending list. Active (already-started) requests are not affected here —
   * callers should abort those separately via {@link InFlightTracker.clear}.
   *
   * Intended to be called by {@link SoroWillClient.destroy} so that any
   * requests enqueued after unmount/teardown do not run to completion.
   */
  rejectAll(reason: unknown): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    const drained = this.pending.splice(0);
    for (const request of drained) {
      this.removeAbortListener(request);
      request.reject(reason);
    }
  }

  private removeAbortListener(request: { signal: AbortSignal | undefined; abortListener: (() => void) | undefined }): void {
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener('abort', request.abortListener);
    }
  }

  private drain(): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    const now = Date.now();
    while (this.starts[0] !== undefined && this.starts[0] <= now - 1_000) {
      this.starts.shift();
    }
    while (
      this.active < this.maxConcurrent &&
      this.starts.length < this.requestsPerSecond &&
      this.pending.length > 0
    ) {
      const request = this.selectNextRequest();
      if (request === undefined) break;
      this.active += 1;
      this.starts.push(Date.now());
      this.removeAbortListener(request);
      void this.execute(request);
    }
    if (
      this.pending.length > 0 &&
      this.active < this.maxConcurrent &&
      this.starts[0] !== undefined
    ) {
      const delay = Math.max(1, this.starts[0] + 1_000 - Date.now());
      this.wakeTimer = setTimeout(() => this.drain(), delay);
    }
  }

  private selectNextRequest(): PendingRequest<unknown> | undefined {
    if (this.pending.length === 0) {
      return undefined;
    }
    let selectedIndex = 0;
    let selectedPriority = this.pending[0]!.priority;
    for (let i = 1; i < this.pending.length; i++) {
      if (this.pending[i]!.priority > selectedPriority) {
        selectedIndex = i;
        selectedPriority = this.pending[i]!.priority;
      }
    }
    const [request] = this.pending.splice(selectedIndex, 1);
    return request;
  }

  private async execute<T>(request: PendingRequest<T>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result =
        request.timeoutMs === undefined
          ? await request.run()
          : await Promise.race([
              request.run(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new RequestTimeoutError(request.timeoutMs as number)),
                  request.timeoutMs,
                );
              }),
            ]);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.removeAbortListener(request);
      this.active -= 1;
      this.drain();
    }
  }
}
