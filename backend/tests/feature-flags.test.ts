import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlagOverridesFromMap, getClient, OverrideBehaviour, PollingMode } from '@configcat/sdk/node';
import { paidTiersEnabled } from '../src/feature-flags.js';

test('paid tiers default to off and follow ConfigCat values without a restart', async (t) => {
  const originalKey = process.env.CONFIGCAT_SDK_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.CONFIGCAT_SDK_KEY;
    else process.env.CONFIGCAT_SDK_KEY = originalKey;
  });
  delete process.env.CONFIGCAT_SDK_KEY;
  assert.equal(await paidTiersEnabled(), false);
  process.env.CONFIGCAT_SDK_KEY = 'invalid';
  const log = t.mock.method(console, 'error', () => {});
  assert.equal(await paidTiersEnabled(), false);
  log.mock.restore();

  process.env.CONFIGCAT_SDK_KEY = 'aaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb';
  const flags: Record<string, boolean | string> = { paidTiersEnabled: true };
  const client = getClient(process.env.CONFIGCAT_SDK_KEY, PollingMode.ManualPoll, {
    flagOverrides: createFlagOverridesFromMap(flags, OverrideBehaviour.LocalOnly, true),
    logger: { log() {} },
  });
  t.after(() => client.dispose());
  assert.equal(await paidTiersEnabled(), true);
  flags.paidTiersEnabled = false;
  assert.equal(await paidTiersEnabled(), false);
  delete flags.paidTiersEnabled;
  assert.equal(await paidTiersEnabled(), false);
  flags.paidTiersEnabled = 'true';
  assert.equal(await paidTiersEnabled(), false, 'a string cannot enable purchases');
});
