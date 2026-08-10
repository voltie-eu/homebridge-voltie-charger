import { promises as dns } from 'dns';

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
import { VoltieApiError, VoltieClient } from './client';
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
  REDISCOVERY_INTERVAL_MS,
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
  singlePhaseSwitch?: boolean | string;
  rebootSwitch?: boolean;
  rearLedLight?: boolean;
}

/** What a discovered charger persists in the accessory context: no secrets. */
interface DiscoveredContext {
  name: string;
  host: string;
  port: number;
  shortId: string;
}

export class VoltieChargerPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly eve: EveCharacteristics;

  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly handled = new Set<string>();

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
    const handled = this.handled;

    for (const entry of entries) {
      if (!entry.host) {
        this.log.error('Skipping charger entry without "host": %s', JSON.stringify(entry));
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`voltie-charger:${entry.host}:${entry.port ?? DEFAULT_PORT}`);
      if (handled.has(uuid)) {
        this.log.warn('Duplicate charger entry for %s:%d ignored', entry.host, entry.port ?? DEFAULT_PORT);
        continue;
      }
      this.startCharger(uuid, this.withDefaultCredentials(entry), undefined);
      handled.add(uuid);
    }

    // Manual entries may use DNS names; resolve them so discovery can tell
    // that an mDNS hit is the same physical device as a configured one.
    const manualAddresses = await resolveManualAddresses(entries);
    const coveredByManual = (address: string, shortId: string): boolean =>
      manualAddresses.has(address)
      || entries.some((entry) => (entry.host ?? '').toLowerCase().includes(`voltiecharger-${shortId}`));

    if (this.config.discovery !== false) {
      await this.discoverAndStart(coveredByManual, handled);

      // Previously discovered chargers that did not answer this browse
      // (powered off, busy network) keep working from their cached context
      // instead of disappearing from HomeKit.
      for (const cached of this.cachedAccessories) {
        if (handled.has(cached.UUID)) {
          continue;
        }
        const ctx = cached.context.discovered as DiscoveredContext | undefined;
        if (ctx?.host && !coveredByManual(ctx.host, ctx.shortId ?? '')) {
          this.log.info('Keeping previously discovered charger: %s (%s)', cached.displayName, ctx.host);
          this.startCharger(cached.UUID, { name: ctx.name, host: ctx.host, port: ctx.port }, ctx);
          handled.add(cached.UUID);
        }
      }
    }

    const stale = this.cachedAccessories.filter((cached) => !handled.has(cached.UUID));
    if (stale.length > 0) {
      this.log.info('Removing %d charger(s) no longer present in config or on the network', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    // Chargers added to the network later show up without a restart.
    if (this.config.discovery !== false) {
      const timer = setInterval(() => {
        this.discoverAndStart(coveredByManual, handled, true)
          .catch((error) => this.log.debug('Periodic discovery failed: %s', error));
      }, REDISCOVERY_INTERVAL_MS);
      this.api.on('shutdown', () => clearInterval(timer));
    }
  }

  private async discoverAndStart(
    coveredByManual: (address: string, shortId: string) => boolean,
    handled: Set<string>,
    quiet = false,
  ): Promise<void> {
    const logLine = quiet ? this.log.debug.bind(this.log) : this.log.info.bind(this.log);
    logLine('Browsing for Voltie chargers via mDNS (%d s)...', DISCOVERY_TIMEOUT_MS / 1000);
    let found;
    try {
      found = await discoverChargers(
        DISCOVERY_TIMEOUT_MS,
        (error) => this.log.warn('mDNS error during discovery: %s', error),
      );
    } catch (error) {
      this.log.warn('mDNS discovery failed: %s', error);
      return;
    }
    logLine('Discovery finished: %d charger(s) found', found.length);

    await Promise.all(found.map(async (charger) => {
      if (coveredByManual(charger.address, charger.shortId)) {
        return;
      }
      const knownUuid = this.api.hap.uuid.generate(`voltie-discovered:${charger.shortId}`);
      if (handled.has(knownUuid)) {
        // Already running from this launch; a re-browse must not spawn a
        // second handler for the same charger.
        return;
      }
      // Only chargers with a working HTTP API become accessories; a charger
      // that advertises via mDNS but has the API disabled would otherwise sit
      // in HomeKit as a permanent "No Response" tile.
      const uuid = this.api.hap.uuid.generate(`voltie-discovered:${charger.shortId}`);
      const alreadyCached = this.cachedAccessories.some((cached) => cached.UUID === uuid);
      if (!alreadyCached) {
        const probe = await this.probeCharger(charger.address);
        if (probe === 'auth') {
          this.log.info(
            'Found charger %s at %s, but its HTTP API requires authentication; skipping. '
            + 'Set the platform-level username/password, or add the charger manually with credentials.',
            charger.shortId.toUpperCase(), charger.address,
          );
          return;
        }
        if (probe === 'fail') {
          this.log.info(
            'Found charger %s at %s, but its HTTP API is not reachable; skipping. '
            + 'Enable the HTTP API in the Voltie app to use it with HomeKit.',
            charger.shortId.toUpperCase(), charger.address,
          );
          return;
        }
      }
      const ctx: DiscoveredContext = {
        name: `Voltie ${charger.shortId.toUpperCase()}`,
        host: charger.address,
        port: DEFAULT_PORT,
        shortId: charger.shortId,
      };
      this.startCharger(uuid, this.withDefaultCredentials({ name: ctx.name, host: ctx.host, port: ctx.port }), ctx);
      handled.add(uuid);
    }));
  }

  private async probeCharger(address: string): Promise<'ok' | 'auth' | 'fail'> {
    const { username, password } = this.defaultCredentials();
    try {
      await new VoltieClient(address, DEFAULT_PORT, username, password).getStatus();
      return 'ok';
    } catch (error) {
      return error instanceof VoltieApiError && error.message.includes('Authentication')
        ? 'auth'
        : 'fail';
    }
  }

  /** Platform-level credentials apply to discovered chargers and to manual
   * entries that don't carry their own. */
  private defaultCredentials(): { username?: string; password?: string } {
    const username = typeof this.config.username === 'string' && this.config.username ? this.config.username : undefined;
    const password = typeof this.config.password === 'string' && this.config.password ? this.config.password : undefined;
    return username && password ? { username, password } : {};
  }

  private withDefaultCredentials(entry: ChargerConfigEntry): ChargerConfigEntry {
    if (entry.username && entry.password) {
      return entry;
    }
    return { ...entry, ...this.defaultCredentials() };
  }

  private startCharger(uuid: string, entry: ChargerConfigEntry, discovered: DiscoveredContext | undefined): void {
    const port = entry.port ?? DEFAULT_PORT;
    const rawInterval = Number(entry.pollInterval);
    const pollInterval = clamp(
      Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : DEFAULT_POLL_INTERVAL_S,
      MIN_POLL_INTERVAL_S,
      MAX_POLL_INTERVAL_S,
    );
    const name = entry.name || `Voltie ${entry.host}`;

    if ((entry.username || entry.password) && !(entry.username && entry.password)) {
      this.log.warn('[%s] Both username and password are needed for HTTP API auth; ignoring the one given', name);
    }

    let accessory = this.cachedAccessories.find((cached) => cached.UUID === uuid);
    if (accessory) {
      this.log.info('Restoring charger from cache: %s (%s:%d)', name, entry.host, port);
    } else {
      this.log.info('Adding charger: %s (%s:%d)%s', name, entry.host, port, discovered ? ' [discovered]' : '');
      accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.OUTLET);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.push(accessory);
    }
    accessory.category = this.api.hap.Categories.OUTLET;
    // Only discovered chargers persist context (host/port/name, no secrets);
    // manual entries always come from config.json.
    accessory.context.discovered = discovered;

    new VoltieChargerAccessory(this, accessory, { ...entry, port, pollInterval, name });
  }
}

async function resolveManualAddresses(entries: ChargerConfigEntry[]): Promise<Set<string>> {
  const addresses = new Set<string>();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.host) {
      return;
    }
    addresses.add(entry.host);
    try {
      for (const result of await dns.lookup(entry.host, { all: true })) {
        addresses.add(result.address);
      }
    } catch {
      // Unresolvable now (e.g. .local name from a container): the raw host
      // string was still added, and the shortId match remains as fallback.
    }
  }));
  return addresses;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
