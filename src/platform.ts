import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { VoltieChargerAccessory } from './accessory';
import { buildEveCharacteristics, EveCharacteristics } from './eve';
import {
  DEFAULT_POLL_INTERVAL_S,
  DEFAULT_PORT,
  MAX_POLL_INTERVAL_S,
  MIN_POLL_INTERVAL_S,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';

export interface ChargerConfigEntry {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  pollInterval?: number;
  idTag?: string;
  currentControl?: boolean;
  carConnectedSensor?: boolean;
  faultSensor?: boolean;
  accessLock?: boolean;
  autostartSwitch?: boolean;
}

export class VoltieChargerPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly eve: EveCharacteristics;

  private readonly cachedAccessories: PlatformAccessory[] = [];

  constructor(
    readonly log: Logging,
    private readonly config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.eve = buildEveCharacteristics(api);

    api.on('didFinishLaunching', () => this.discoverChargers());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private discoverChargers(): void {
    const entries = Array.isArray(this.config.chargers)
      ? (this.config.chargers as ChargerConfigEntry[])
      : [];
    if (entries.length === 0) {
      this.log.warn('No chargers configured; add entries under "chargers" in the platform config.');
    }

    const activeUuids = new Set<string>();

    for (const entry of entries) {
      if (!entry.host) {
        this.log.error('Skipping charger entry without "host": %s', JSON.stringify(entry));
        continue;
      }
      const port = entry.port ?? DEFAULT_PORT;
      const pollInterval = clamp(
        entry.pollInterval ?? DEFAULT_POLL_INTERVAL_S,
        MIN_POLL_INTERVAL_S,
        MAX_POLL_INTERVAL_S,
      );
      const uuid = this.api.hap.uuid.generate(`voltie-charger:${entry.host}:${port}`);
      activeUuids.add(uuid);

      let accessory = this.cachedAccessories.find((cached) => cached.UUID === uuid);
      const name = entry.name || `Voltie ${entry.host}`;
      if (accessory) {
        this.log.info('Restoring charger from cache: %s (%s:%d)', name, entry.host, port);
        accessory.context.entry = entry;
      } else {
        this.log.info('Adding charger: %s (%s:%d)', name, entry.host, port);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.entry = entry;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      new VoltieChargerAccessory(this, accessory, { ...entry, port, pollInterval, name });
    }

    const stale = this.cachedAccessories.filter((cached) => !activeUuids.has(cached.UUID));
    if (stale.length > 0) {
      this.log.info('Removing %d charger(s) no longer present in config', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
