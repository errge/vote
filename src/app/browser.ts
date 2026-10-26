// Real browser dependencies for PollSession.
import { Transport } from '../nostr/transport';
import type { SessionDeps } from './session';

export function browserDeps(): SessionDeps {
  return {
    store: safeLocalStorage(),
    now: () => Date.now(),
    createTransport: (relays, filter, handlers) => new Transport(relays, filter, handlers),
    lock: typeof navigator !== 'undefined' && navigator.locks
      ? <T,>(name: string, fn: () => Promise<T>) => navigator.locks.request(name, fn) as Promise<T>
      : undefined,
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
