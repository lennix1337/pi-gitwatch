import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghEnv } from '../src/github.ts';

test('gh runs with telemetry off, so no detached send-telemetry child opens a console window', () => {
  const env = ghEnv({ PATH: 'x', GH_TELEMETRY: 'log' });
  assert.equal(env.GH_TELEMETRY, '0');
  assert.equal(env.PATH, 'x');
});
