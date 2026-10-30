# pi-gitwatch

Read-only GitHub PR watcher for Pi. Keep the extension read-only on GitHub: it reports, the agent acts. Keep notices compact and decision-first; every wake event needs a test in `test/model.test.ts` or `test/watcher.test.ts`. Only interactive sessions poll (lease in the state dir); never make subagents or one-shot runs poll.

Use `.pi/checks.json` (`typecheck`, `unit`); tests use a fake `gh` and touch no network. Runtime state stays outside Git.
