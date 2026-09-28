export interface WillEvent {
  type: string;
  willId: string;
  payload?: unknown;
}

export type WillEventListener = (event: WillEvent) => void;
export type WillEventSubscription = (() => void) | { unsubscribe(): void };

export interface WillEventSource {
  subscribe(listener: WillEventListener): WillEventSubscription;
}

/**
 * Known SoroWill event types that can be subscribed to.
 */
export const SORO_WILL_EVENT_TYPES = [
  'willCreated',
  'willUpdated',
  'willClaimed',
  'willCancelled',
  'willExecuted',
] as const;

export type SoroWillEventType = (typeof SORO_WILL_EVENT_TYPES)[number];

/**
 * Error thrown when an unknown event type is passed to addEventListener.
 */
export class EventTypeError extends Error {
  readonly eventType: string;

  constructor(eventType: string) {
    super(
      `Unknown event type: "${eventType}". Supported event types are: ${SORO_WILL_EVENT_TYPES.join(
        ', ',
      )}.`,
    );
    this.name = 'EventTypeError';
    this.eventType = eventType;
  }
}

function isKnownEventType(eventType: string): eventType is SoroWillEventType {
  return (SORO_WILL_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Validates that the provided event type is a recognized SoroWillEvent type.
 * Throws an EventTypeError for unknown event types.
 */
export function validateEventType(eventType: string): SoroWillEventType {
  if (!isKnownEventType(eventType)) {
    throw new EventTypeError(eventType);
  }

  return eventType;
}

/**
 * Subscribes a listener to a known SoroWill event type.
 * Rejects unknown event types with an EventTypeError instead of silently
 * subscribing to an event that will never fire.
 */
export function addEventListener(
  eventType: string,
  listener: WillEventListener,
  source: WillEventSource,
): WillEventSubscription {
  validateEventType(eventType);

  return source.subscribe((event) => {
    if (event.type === eventType) {
      listener(event);
    }
  });
}

export function unsubscribeFromWillEvents(subscription: WillEventSubscription): void {
  if (typeof subscription === 'function') {
    subscription();
    return;
  }

  subscription.unsubscribe();
}
