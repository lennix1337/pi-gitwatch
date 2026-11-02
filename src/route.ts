import type { Announced, Slot, Snapshot, WatchEvent } from './model.ts';

/**
 * Fast path before any delivery (no model involved): `respond` wakes the session now, `candidate` waits in the batch of
 * the next notice, `ignore` is counted in status and never sent.
 */
export type Route = 'respond' | 'candidate' | 'ignore';
export interface Decision { route: Route; reason: 'wake' | 'quiet' | 'repeat' | 'own-merge' }

/** A positive confirmation on this head: checks passed or ready to merge. Only these are suppressed once announced. */
export function confirmation(e: WatchEvent, cur: Snapshot): { slot: Slot; value: string } | undefined {
  if (e.kind === 'checks' && cur.checks.state === 'pass') return { slot: 'checks', value: `pass@${cur.head}` };
  if (e.kind === 'mergeState' && cur.mergeState === 'CLEAN' && !cur.auto && !cur.draft) return { slot: 'mergeState', value: `CLEAN@${cur.head}` };
  return undefined;
}

/** The slot a delivered PR event leaves behind, so the next identical confirmation is recognised as a repeat. */
function slotOf(e: WatchEvent, cur: Snapshot): { slot: Slot; value: string } | undefined {
  if (e.kind === 'checks' && e.pr > 0 && e.branch === undefined) return { slot: 'checks', value: `${cur.checks.state}@${cur.head}` };
  if (e.kind === 'mergeState') return { slot: 'mergeState', value: `${cur.mergeState}@${cur.head}` };
  return undefined;
}

/** Records what a `respond` event told the agent about the PR, so an identical later confirmation is not repeated. */
export function announce(announced: Announced | undefined, e: WatchEvent, cur: Snapshot): Announced | undefined {
  const slot = slotOf(e, cur);
  return slot ? { ...announced, [slot.slot]: slot.value } : announced;
}

/**
 * The rules, in order: a merge this session performed is already known (ignored); an event that does not wake is a
 * candidate; a confirmation the agent was already told about on this head is a repeat (candidate); everything else
 * wakes. Failures, conflicts, reviews, stalls, closes and merges nobody here performed always wake.
 */
export function routeEvent(e: WatchEvent, ctx: { ownMerge?: boolean; cur?: Snapshot; announced?: Announced } = {}): Decision {
  if (e.kind === 'merged' && ctx.ownMerge) return { route: 'ignore', reason: 'own-merge' };
  if (!e.wake) return { route: 'candidate', reason: 'quiet' };
  const c = ctx.cur && confirmation(e, ctx.cur);
  if (c && ctx.announced?.[c.slot] === c.value) return { route: 'candidate', reason: 'repeat' };
  return { route: 'respond', reason: 'wake' };
}
