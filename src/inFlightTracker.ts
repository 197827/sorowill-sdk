type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
}

export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();

  getKey(willId: string | bigint, method: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    return `${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string): boolean {
    return this.inFlight.has(this.getKey(willId, method));
  }

  getInFlightPromise<T>(willId: string | bigint, method: string): OperationResult<T> | undefined {
    const op = this.inFlight.get(this.getKey(willId, method));
    return op?.promise as OperationResult<T> | undefined;
  }

  track<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): PromiseLike<T> {
    const key = this.getKey(willId, method);

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!.promise as PromiseLike<T>;
    }

    const controller = new AbortController();
    const entry = { controller } as InFlightOperation<T>;
    entry.promise = Promise.resolve(operation(controller.signal)).finally(() => {
      // Only remove the entry this call created; a newer track() may own the key now.
      if (this.inFlight.get(key) === entry) {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, entry as InFlightOperation<unknown>);
    return entry.promise;
  }

  /**
   * Runs `operation` only if no operation is currently in flight for the given
   * will/method pair. Unlike {@link track}, this is intended for timeout-driven
   * follow-up work (e.g. auto fee-bump) where the caller must first confirm the
   * original operation is still pending before acting. If the original operation
   * has already settled (success or failure), the in-flight entry is gone and the
   * guard prevents a duplicate submission.
   */
  trackIfPending<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): PromiseLike<T> | undefined {
    const key = this.getKey(willId, method);

    if (!this.inFlight.has(key)) {
      return undefined;
    }

    return this.track(willId, method, operation);
  }

  clear(): void {
    for (const { controller } of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  abort(willId: string | bigint, method: string): void {
    const key = this.getKey(willId, method);
    const op = this.inFlight.get(key);
    if (op) {
      op.controller.abort();
      this.inFlight.delete(key);
    }
  }
}
