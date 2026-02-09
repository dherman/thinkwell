import type { ThoughtEvent } from "./thought-event.js";

/**
 * A lightweight handle providing both the final typed result (as a promise)
 * and an async iterable of intermediate progress events.
 *
 * Execution starts eagerly when `stream()` is called. The async iterator
 * and the result promise have independent lifecycles:
 *
 * - Iterate without awaiting `.result` (it resolves in the background)
 * - Await `.result` without iterating (events buffer internally)
 * - Do both concurrently
 * - Break out of iteration and still await `.result`
 */
export class ThoughtStream<Output> implements AsyncIterable<ThoughtEvent> {
  /** Resolves with the final typed result. */
  readonly result: Promise<Output>;

  private _resolveResult!: (value: Output) => void;
  private _rejectResult!: (error: Error) => void;

  private _pendingEvents: ThoughtEvent[] = [];
  private _eventResolvers: Array<(value: IteratorResult<ThoughtEvent>) => void> = [];
  private _done: boolean = false;

  constructor() {
    this.result = new Promise<Output>((resolve, reject) => {
      this._resolveResult = resolve;
      this._rejectResult = reject;
    });
  }

  /**
   * Push an event into the stream for consumers to iterate over.
   * @internal
   */
  pushEvent(event: ThoughtEvent): void {
    if (this._done) return;

    if (this._eventResolvers.length > 0) {
      const resolver = this._eventResolvers.shift()!;
      resolver({ value: event, done: false });
    } else {
      this._pendingEvents.push(event);
    }
  }

  /**
   * Signal that no more events will arrive. Flushes waiting consumers.
   * @internal
   */
  close(): void {
    if (this._done) return;
    this._done = true;

    for (const resolver of this._eventResolvers) {
      resolver({ value: undefined as any, done: true });
    }
    this._eventResolvers = [];
  }

  /**
   * Resolve the result promise.
   * @internal
   */
  resolveResult(value: Output): void {
    this._resolveResult(value);
  }

  /**
   * Reject the result promise.
   * @internal
   */
  rejectResult(error: Error): void {
    this._rejectResult(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<ThoughtEvent> {
    return {
      next: (): Promise<IteratorResult<ThoughtEvent>> => {
        if (this._pendingEvents.length > 0) {
          return Promise.resolve({
            value: this._pendingEvents.shift()!,
            done: false,
          });
        }

        if (this._done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }

        return new Promise((resolve) => {
          this._eventResolvers.push(resolve);
        });
      },

      return: (): Promise<IteratorResult<ThoughtEvent>> => {
        // Early termination — stop yielding events but don't kill the operation.
        // The result promise can still resolve independently.
        this._done = true;
        this._pendingEvents = [];
        for (const resolver of this._eventResolvers) {
          resolver({ value: undefined as any, done: true });
        }
        this._eventResolvers = [];
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }
}
