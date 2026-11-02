import type { WatchEvent } from './model.ts';

/** A subscriber label: a subagent or session name, safe as a state value and inside a notice line. */
export const SUBSCRIBER = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Pi event bus channel for notices of PRs and branches a subscriber took (`watch` with `subscriber`). The bus is
 * in-process: a consumer listens with `pi.events.on(SUBSCRIBER_NOTICE_CHANNEL, ...)`, takes the notices whose
 * `subscriber` is its own label, and calls `accept()` synchronously. A notice nobody accepts stays with the main session.
 */
export const SUBSCRIBER_NOTICE_CHANNEL = 'gitwatch:subscriber-notice';

export interface SubscriberNotice {
  subscriber: string; repo: string; wake: boolean; text: string; events: WatchEvent[];
  /** Set by `accept()`: the consumer owns delivery to its session. */
  accepted: boolean;
  accept(): void;
}
