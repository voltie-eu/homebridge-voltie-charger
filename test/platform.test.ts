import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { format } from 'node:util';

import * as hap from 'hap-nodejs';

import type { DiscoveredCharger } from '../src/discovery';
import { VoltieChargerPlatform } from '../src/platform';

// The real PlatformAccessory and HAP library, with a minimal API around them;
// mDNS is replaced so the test controls what each browse "finds".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const discovery = require('../src/discovery');

function setup(config: Record<string, unknown>, browses: DiscoveredCharger[][]) {
  const lines: Array<[string, string]> = [];
  const log = Object.assign(
    (...args: unknown[]) => lines.push(['info', format(...args)]),
    Object.fromEntries(['info', 'warn', 'error', 'debug', 'success'].map((level) =>
      [level, (...args: unknown[]) => lines.push([level, format(...args)])])),
  );
  const api = Object.assign(new EventEmitter(), {
    hap,
    platformAccessory: PlatformAccessory,
    registerPlatformAccessories: () => undefined,
    unregisterPlatformAccessories: () => undefined,
  });
  let browseCount = 0;
  discovery.discoverChargers = async () => browses[Math.min(browseCount++, browses.length - 1)] ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const platform = new VoltieChargerPlatform(log as any, { platform: 'VoltieCharger', ...config } as any, api as any);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    platform: platform as any,
    api,
    lines,
    browses: () => browseCount,
    has: (level: string, text: string) => lines.filter(([l, t]) => l === level && t.includes(text)).length,
  };
}

function cachedDiscovered(shortId: string, host: string) {
  const accessory = new PlatformAccessory(`Voltie ${shortId.toUpperCase()}`, hap.uuid.generate(`voltie-discovered:${shortId}`));
  accessory.context.discovered = { name: `Voltie ${shortId.toUpperCase()}`, host, port: 5059, shortId };
  return accessory;
}

async function until(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('platform discovery', () => {
  it('moves a running discovered charger to its new DHCP address on re-browse', async () => {
    const t = setup({}, [[{ shortId: '77ed', address: '127.0.0.1' }], [{ shortId: '77ed', address: 'localhost' }]]);
    const accessory = cachedDiscovered('77ed', '127.0.0.1');
    t.platform.configureAccessory(accessory);
    t.api.emit('didFinishLaunching');
    await until(() => t.has('info', 'Restoring charger from cache') === 1);

    await t.platform.discoverAndStart(t.platform.handled, true);
    t.api.emit('shutdown');
    assert.equal(t.has('info', 'moved from 127.0.0.1 to localhost'), 1);
    assert.equal(accessory.context.discovered.host, 'localhost');
    assert.equal(t.has('info', 'Adding charger'), 0, 'no second handler for the same charger');
  });

  it('browses again as soon as a discovered charger turns unreachable', async () => {
    const t = setup({ pollInterval: 5 }, [[{ shortId: '77ed', address: '127.0.0.1' }]]);
    t.platform.configureAccessory(cachedDiscovered('77ed', '127.0.0.1'));
    t.api.emit('didFinishLaunching');
    await until(() => t.has('info', 'Restoring charger from cache') === 1);
    assert.equal(t.browses(), 1);

    try {
      // Nothing listens on 127.0.0.1:5059: the startup poll and the next one fail.
      await until(() => t.has('warn', 'Charger unreachable') === 1);
      await until(() => t.browses() === 2, 2000);
    } finally {
      t.api.emit('shutdown');
    }
  });

  it('reports a charger without a reachable HTTP API once, not on every re-browse', async () => {
    const t = setup({}, [[{ shortId: 'abcd', address: '127.0.0.1' }]]);
    t.api.emit('didFinishLaunching');
    await until(() => t.browses() === 1 && t.has('info', 'Discovery finished') === 1);
    await t.platform.discoverAndStart(t.platform.handled, true);
    await t.platform.discoverAndStart(t.platform.handled, true);
    t.api.emit('shutdown');

    assert.equal(t.has('info', 'HTTP API is not reachable'), 1);
    assert.equal(t.has('debug', 'HTTP API is not reachable'), 2);
    assert.equal(t.has('info', 'Adding charger'), 0);
  });
});
