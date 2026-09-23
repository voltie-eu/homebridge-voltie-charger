import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { format } from 'node:util';

import * as hap from 'hap-nodejs';

import { EveEnergyHistory } from '../src/eveHistory';
import { VoltieChargerPlatform } from '../src/platform';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');

/** A charger that keeps its config, like the real one, for end-to-end runs. */
class FakeCharger {
  server!: Server;
  port = 0;
  status: Record<string, unknown> = {};
  config: Record<string, unknown> = {};
  puts: Array<Record<string, unknown>> = [];
  dlmValid = false;

  reset(): void {
    this.status = {
      charger_id: '00000000c01277ed', sw_ver: 1003051, evse_state: 1, is_car_connected: false,
      charge_enabled: false, is_charging: false, phases: 3, current_hw_limit: 32, current_offered: 0,
      charge_power: 0, first_cdr: 1, last_cdr: 7, cdr: null, error_code: 0,
    };
    this.config = {
      conf_disp_enabled: true, conf_front_led_enabled: false, conf_buzzer_enabled: true,
      conf_rear_led_enabled: true, conf_autostart_enabled: 1, conf_current_limit: 16,
      conf_force_single_phase: 0, conf_dlm_mode: 1, conf_out_of_service: false, conf_access_mode: 0,
    };
    this.puts = [];
    this.dlmValid = false;
  }

  async start(): Promise<void> {
    this.reset();
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        let reply: Record<string, unknown> = { error_code: 0 };
        if (url.pathname === '/status') {
          reply = this.status;
        } else if (url.pathname === '/config' && req.method === 'GET') {
          reply = { ...this.config, error_code: 0 };
        } else if (url.pathname === '/config' && req.method === 'PUT') {
          const values = JSON.parse(body) as Record<string, unknown>;
          this.puts.push(values);
          const known = Object.keys(values).filter((key) => key in this.config);
          known.forEach((key) => (this.config[key] = values[key]));
          reply = { accepted: known.length, error_code: 0 };
        } else if (url.pathname === '/cdr') {
          reply = url.searchParams.get('cdr_id') === '7'
            ? { cdr: { cdr_id: 7, chg_energy: 12.5 }, error_code: 0 }
            : { cdr: null, error_code: 0 };
        } else if (url.pathname === '/power') {
          reply = { power_stat: { dlm_valid: this.dlmValid }, error_code: 0 };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not reached');
    }
    await sleep(20);
  }
}

/** Runs the real platform against the fake charger; returns its accessory. */
async function launch(charger: FakeCharger, options: Record<string, unknown>, cached?: unknown) {
  const lines: Array<[string, string]> = [];
  const log = Object.assign(
    (...args: unknown[]) => lines.push(['info', format(...args)]),
    Object.fromEntries(['info', 'warn', 'error', 'debug', 'success'].map((level) =>
      [level, (...args: unknown[]) => lines.push([level, format(...args)])])),
  );
  const storage = mkdtempSync(join(tmpdir(), 'voltie-test-'));
  const registered: unknown[] = [];
  const api = Object.assign(new EventEmitter(), {
    hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: () => storage },
    registerPlatformAccessories: (_p: string, _n: string, list: unknown[]) => registered.push(...list),
    unregisterPlatformAccessories: () => undefined,
  });
  const config = {
    platform: 'VoltieCharger',
    discovery: false,
    chargers: [{ name: 'Test', host: '127.0.0.1', port: charger.port, ...options }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const platform = new VoltieChargerPlatform(log as any, config as any, api as any);
  if (cached) {
    platform.configureAccessory(cached as never);
  }
  api.emit('didFinishLaunching');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await until(() => lines.some(([, text]) => text.includes('charger')));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessory: any = cached ?? registered[0];
  const serial = () => accessory.getService(hap.Service.AccessoryInformation)
    .getCharacteristic(hap.Characteristic.SerialNumber).value;
  await until(() => serial() === '00000000c01277ed'); // first poll applied
  return {
    accessory,
    lines,
    shutdown: () => api.emit('shutdown'),
    switchOf: (subtype: string) => accessory.getServiceById(hap.Service.Switch, subtype),
    set: async (subtype: string, on: boolean) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const char: any = accessory.getServiceById(hap.Service.Switch, subtype).getCharacteristic(hap.Characteristic.On);
      await char.handleSetRequest(on);
    },
  };
}

describe('config switches (end to end against a fake charger)', () => {
  const charger = new FakeCharger();
  before(() => charger.start());
  after(() => new Promise<void>((resolve) => charger.server.close(() => resolve())));

  it('adds none of the new switches unless enabled in the config', async () => {
    charger.reset();
    const t = await launch(charger, {});
    t.shutdown();
    for (const subtype of ['out-of-service', 'quiet-mode', 'dlm-dynamic', 'dlm-eco', 'dlm-green', 'dlm-grid']) {
      assert.equal(t.switchOf(subtype), undefined, subtype);
    }
    assert.equal(t.accessory.services.some((s: { UUID: string }) => s.UUID.startsWith('E863F007')), false);
  });

  it('quiet mode turns display, front LED and buzzer off, and restores them', async () => {
    charger.reset();
    const t = await launch(charger, { quietModeSwitch: true });
    try {
      await t.set('quiet-mode', true);
      assert.deepEqual(charger.puts.at(-1), {
        conf_disp_enabled: false, conf_front_led_enabled: false, conf_buzzer_enabled: false,
      });
      await t.set('quiet-mode', false);
      // The front LED was off before quiet mode, so it stays off.
      assert.deepEqual(charger.puts.at(-1), {
        conf_disp_enabled: true, conf_front_led_enabled: false, conf_buzzer_enabled: true,
      });
    } finally {
      t.shutdown();
    }
  });

  it('mode switches act like radio buttons over the single conf_dlm_mode field', async () => {
    charger.reset(); // conf_dlm_mode = 1 (Dynamic)
    const t = await launch(charger, { dlmDynamicSwitch: true, ecoModeSwitch: true });
    const on = (subtype: string) => t.switchOf(subtype).getCharacteristic(hap.Characteristic.On).value;
    try {
      assert.equal(on('dlm-dynamic'), true);
      assert.equal(on('dlm-eco'), false);
      await t.set('dlm-eco', true);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 2 });
      assert.equal(on('dlm-dynamic'), false);
      assert.equal(on('dlm-eco'), true);
      await t.set('dlm-eco', false); // back to what was active before
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 1 });
      assert.equal(on('dlm-dynamic'), true);
    } finally {
      t.shutdown();
    }
  });

  it('Eco restores the previous mode and warns when there is no meter', async () => {
    charger.reset();
    charger.config.conf_dlm_mode = 4; // Grid Control before
    const t = await launch(charger, { ecoModeSwitch: true });
    try {
      await t.set('dlm-eco', true);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 2 });
      await until(() => t.lines.some(([level, text]) => level === 'warn' && text.includes('no external meter')));
      await t.set('dlm-eco', false);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 4 });
    } finally {
      t.shutdown();
    }
  });

  it('Green with a meter present does not warn', async () => {
    charger.reset();
    charger.dlmValid = true;
    const t = await launch(charger, { greenModeSwitch: true });
    try {
      await t.set('dlm-green', true);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 3 });
      await sleep(100);
      assert.equal(t.lines.some(([, text]) => text.includes('no external meter')), false);
    } finally {
      t.shutdown();
    }
  });

  it('turning Dynamic off without an earlier mode turns load management off, with a warning', async () => {
    charger.reset();
    charger.config.conf_dlm_mode = 0;
    const t = await launch(charger, { dlmDynamicSwitch: true });
    try {
      await t.set('dlm-dynamic', true);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 1 });
      await t.set('dlm-dynamic', false);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 0 });
      assert.ok(t.lines.some(([level, text]) => level === 'warn' && text.includes('Load management is now off')));
    } finally {
      t.shutdown();
    }
  });

  it('Grid Control needs no meter, so it does not warn', async () => {
    charger.reset();
    const t = await launch(charger, { gridControlSwitch: true });
    try {
      await t.set('dlm-grid', true);
      assert.deepEqual(charger.puts.at(-1), { conf_dlm_mode: 4 });
      await sleep(100);
      assert.equal(t.lines.some(([, text]) => text.includes('no external meter')), false);
    } finally {
      t.shutdown();
    }
  });

  it('out of service switch writes the flag', async () => {
    charger.reset();
    const t = await launch(charger, { outOfServiceSwitch: true });
    try {
      await t.set('out-of-service', true);
      assert.deepEqual(charger.puts.at(-1), { conf_out_of_service: true });
      assert.equal(charger.config.conf_out_of_service, true);
    } finally {
      t.shutdown();
    }
  });

  it('keeps the last session energy between sessions, unless disabled', async () => {
    const total = (accessory: { getService: (s: unknown) => { characteristics: Array<{ UUID: string; value: unknown }> } }) =>
      accessory.getService(hap.Service.Outlet).characteristics.find((c) => c.UUID.startsWith('E863F10C'))?.value;

    charger.reset();
    let t = await launch(charger, {});
    await until(() => total(t.accessory) === 12.5);
    t.shutdown();

    charger.reset();
    t = await launch(charger, { keepLastSessionEnergy: false });
    await sleep(200);
    assert.equal(total(t.accessory), 0);
    t.shutdown();
  });

  it('removes a switch from the cached accessory once it is disabled again', async () => {
    charger.reset();
    const first = await launch(charger, { quietModeSwitch: true, eveHistory: true });
    first.shutdown();
    assert.ok(first.switchOf('quiet-mode'));
    assert.ok(first.accessory.services.some((s: { UUID: string }) => s.UUID.startsWith('E863F007')));

    const second = await launch(charger, {}, first.accessory);
    second.shutdown();
    assert.equal(second.switchOf('quiet-mode'), undefined);
    assert.equal(second.accessory.services.some((s: { UUID: string }) => s.UUID.startsWith('E863F007')), false);
  });
});

describe('EveEnergyHistory', () => {
  // Golden values produced by fakegato-history 0.6.7 for the same entries.
  it('encodes exactly like fakegato-history', () => {
    const accessory = new PlatformAccessory('A', hap.uuid.generate('g'));
    const nolog = Object.assign(() => undefined, { debug: () => undefined });
    const file = join(mkdtempSync(join(tmpdir(), 'voltie-hist-')), 'h.json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any = new EveEnergyHistory({ hap } as any, accessory, file, nolog as any);
    const t0 = 1790186000;
    for (const [dt, power] of [[0, 7400.5], [600, 11040], [1200, 0]]) {
      history.addEntry({ time: t0 + dt, power });
    }
    const service = accessory.services.find((s: { UUID: string }) => s.UUID.startsWith('E863F007'));
    const s2r1 = service.characteristics.find((c: { UUID: string }) => c.UUID.startsWith('E863F116')).value;
    assert.equal(s2r1, 'sAQAAAAAAACQSWQwBAECAgIHAg8DBQDADwAAAAAAAAAAAQE=');

    history.writeS2W1(Buffer.from('000001000000', 'hex').toString('base64'));
    assert.equal(history.readS2R2(),
      'FQEAAAABAAAAgZBJZDAAAAAAAAAAFAIAAAAAAAAAHwAAAAAVIQAAAAAUAwAAAFgCAAAfAAAAAECvAAAAABQEAAAAsAQAAB8AAAAAAAAAAAAA');
    assert.equal(history.readS2R2(), 'AA==');
  });

  it('averages samples per interval and repeats the last value when none arrive', () => {
    const accessory = new PlatformAccessory('B', hap.uuid.generate('b'));
    const nolog = Object.assign(() => undefined, { debug: () => undefined });
    const file = join(mkdtempSync(join(tmpdir(), 'voltie-hist-')), 'h.json');
    let now = 1790186000_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any = new EveEnergyHistory({ hap } as any, accessory, file, nolog as any, () => now);
    history.flush(); // nothing yet: no entry
    assert.equal(history.usedMemory, 0);
    history.addSample(1000);
    history.addSample(3000);
    history.flush();
    now += 600_000;
    history.flush(); // unreachable interval: repeats 2000 W
    history.stop();
    const entries = history.history.filter((e: { power?: number }) => typeof e === 'object' && 'power' in e);
    assert.deepEqual(entries.map((e: { power: number }) => e.power), [2000, 2000]);
  });
});
