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
import { VoltieClient } from './client';
import { discoverChargers } from './discovery';
import { buildEveCharacteristics, EveCharacteristics } from './eve';
import {
  DEFAULT_POLL_INTERVAL_S,
  DEFAULT_PORT,
  DISCOVERY_TIMEOUT_MS,
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

    api.on('didFinishLaunching', () => {
      this.setupChargers().catch((error) => this.log.error('Charger setup failed: %s', error));
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private async setupChargers(): Promise<void> {
    const entries = Array.isArray(this.config.chargers)
      ? (this.config.chargers as ChargerConfigEntry[])
      : [];
    const handled = new Set<string>();

    for (const entry of entries) {
      if (!entry.host) {
        this.log.error('Skipping charger entry without "host": %s', JSON.stringify(entry));
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`voltie-charger:${entry.host}:${entry.port ?? DEFAULT_PORT}`);
      this.startCharger(uuid, entry, false);
      handled.add(uuid);
    }

    if (this.config.discovery !== false) {
      await this.discoverAndStart(entries, handled);
    }

    // Previously discovered chargers that did not answer this browse (powered
    // off, busy network) keep working from their cached context instead of
    // disappearing from HomeKit.
    for (const cached of this.cachedAccessories) {
      if (handled.has(cached.UUID)) {
        continue;
      }
      const entry = cached.context.entry as ChargerConfigEntry | undefined;
      if (cached.context.discovered === true && entry?.host) {
        this.log.info('Keeping previously discovered charger: %s (%s)', cached.displayName, entry.host);
        this.startCharger(cached.UUID, entry, true);
        handled.add(cached.UUID);
      }
    }

    const stale = this.cachedAccessories.filter((cached) => !handled.has(cached.UUID));
    if (stale.length > 0) {
      this.log.info('Removing %d charger(s) no longer present in config', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private async discoverAndStart(entries: ChargerConfigEntry[], handled: Set<string>): Promise<void> {
    this.log.info('Browsing for Voltie chargers via mDNS (%d s)...', DISCOVERY_TIMEOUT_MS / 1000);
    let found;
    try {
      found = await discoverChargers(DISCOVERY_TIMEOUT_MS);
    } catch (error) {
      this.log.warn('mDNS discovery failed: %s', error);
      return;
    }
    this.log.info('Discovery finished: %d charger(s) found', found.length);

    await Promise.all(found.map(async (charger) => {
      // A manually configured entry for the same device wins over discovery.
      const manual = entries.some((entry) =>
        entry.host === charger.address
        || (entry.host ?? '').toLowerCase().includes(`voltiecharger-${charger.shortId}`),
      );
      if (manual) {
        return;
      }
      // Only chargers with a working HTTP API become accessories; a charger
      // that advertises via mDNS but has the API disabled would otherwise sit
      // in HomeKit as a permanent "No Response" tile.
      const uuid = this.api.hap.uuid.generate(`voltie-discovered:${charger.shortId}`);
      const alreadyCached = this.cachedAccessories.some((cached) => cached.UUID === uuid);
      if (!alreadyCached && !(await this.probeCharger(charger.address))) {
        this.log.info(
          'Found charger %s at %s, but its HTTP API is not reachable; skipping. '
          + 'Enable the HTTP API in the Voltie app to use it with HomeKit.',
          charger.shortId.toUpperCase(), charger.address,
        );
        return;
      }
      const entry: ChargerConfigEntry = {
        name: `Voltie ${charger.shortId.toUpperCase()}`,
        host: charger.address,
        port: DEFAULT_PORT,
      };
      this.startCharger(uuid, entry, true);
      handled.add(uuid);
    }));
  }

  private async probeCharger(address: string): Promise<boolean> {
    try {
      await new VoltieClient(address, DEFAULT_PORT).getStatus();
      return true;
    } catch {
      return false;
    }
  }

  private startCharger(uuid: string, entry: ChargerConfigEntry, discovered: boolean): void {
    const port = entry.port ?? DEFAULT_PORT;
    const pollInterval = clamp(
      entry.pollInterval ?? DEFAULT_POLL_INTERVAL_S,
      MIN_POLL_INTERVAL_S,
      MAX_POLL_INTERVAL_S,
    );
    const name = entry.name || `Voltie ${entry.host}`;

    let accessory = this.cachedAccessories.find((cached) => cached.UUID === uuid);
    if (accessory) {
      this.log.info('Restoring charger from cache: %s (%s:%d)', name, entry.host, port);
      accessory.context.entry = entry;
      accessory.context.discovered = discovered;
    } else {
      this.log.info('Adding charger: %s (%s:%d)%s', name, entry.host, port, discovered ? ' [discovered]' : '');
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.entry = entry;
      accessory.context.discovered = discovered;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    new VoltieChargerAccessory(this, accessory, { ...entry, port, pollInterval, name });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
