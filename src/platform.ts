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
import { errorText, isAuthError, VoltieClient } from './client';
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
  UNREACHABLE_REDISCOVERY_MIN_GAP_MS,
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
  chargeCompleteSensor?: boolean;
  accessLock?: boolean;
  autostartSwitch?: boolean;
  singlePhaseSwitch?: boolean | string;
  rebootSwitch?: boolean;
  rearLedLight?: boolean;
  outOfServiceSwitch?: boolean;
  quietModeSwitch?: boolean;
  dlmDynamicSwitch?: boolean;
  ecoModeSwitch?: boolean;
  greenModeSwitch?: boolean;
  gridControlSwitch?: boolean;
  keepLastSessionEnergy?: boolean;
  eveHistory?: boolean;
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
  // Running handlers of discovered chargers, so a re-browse can move one to
  // its new DHCP address instead of leaving it "No Response" until restart.
  private readonly discoveredRunning = new Map<string, VoltieChargerAccessory>();
  // Chargers skipped by the API probe, with the reason; logged once per
  // change instead of on every 10-minute re-browse.
  private readonly skipped = new Map<string, 'auth' | 'fail'>();
  private coveredByManual: (address: string, shortId: string) => boolean = () => false;
  private discoveryRunning = false;
  private stopped = false;
  private lastUnreachableBrowse = 0;

  constructor(
    readonly log: Logging,
    private readonly config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.eve = buildEveCharacteristics(api);

    api.on('shutdown', () => {
      this.stopped = true;
    });
    api.on('didFinishLaunching', () => {
      this.setupChargers().catch((error) => this.log.error('Charger setup failed: %s', errorText(error)));
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
        // The config UI saves a blank row when the user leaves the (optional)
        // Chargers list untouched; with discovery on that is a normal setup,
        // not an error.
        if (this.config.discovery !== false) {
          this.log.info('Ignoring charger entry without "host" (discovery is on; the Chargers list may stay empty)');
        } else {
          this.log.warn('Ignoring charger entry without "host": %s', JSON.stringify(entry));
        }
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
    this.coveredByManual = coveredByManual;

    if (this.config.discovery !== false) {
      await this.discoverAndStart(handled);

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
          this.startCharger(cached.UUID, this.withDefaultCredentials({ name: ctx.name, host: ctx.host, port: ctx.port }), ctx);
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
        this.discoverAndStart(handled, true)
          .catch((error) => this.log.debug('Periodic discovery failed: %s', error));
      }, REDISCOVERY_INTERVAL_MS);
      this.api.on('shutdown', () => clearInterval(timer));
    }
  }

  /** A discovered charger stopped answering: most often a new DHCP lease, so
   * browse again right away instead of waiting for the periodic re-browse. */
  private onDiscoveredUnreachable(): void {
    const now = Date.now();
    if (now - this.lastUnreachableBrowse < UNREACHABLE_REDISCOVERY_MIN_GAP_MS) {
      return;
    }
    this.lastUnreachableBrowse = now;
    this.discoverAndStart(this.handled, true)
      .catch((error) => this.log.debug('Re-discovery after unreachable charger failed: %s', error));
  }

  private async discoverAndStart(handled: Set<string>, quiet = false): Promise<void> {
    // One mDNS browse at a time; the periodic and the unreachable-triggered
    // browse could otherwise overlap and race on the same charger.
    if (this.discoveryRunning || this.stopped) {
      return;
    }
    this.discoveryRunning = true;
    try {
      await this.browseAndStart(handled, quiet);
    } finally {
      this.discoveryRunning = false;
    }
  }

  private async browseAndStart(handled: Set<string>, quiet: boolean): Promise<void> {
    const coveredByManual = this.coveredByManual;
    const logLine = quiet ? this.log.debug.bind(this.log) : this.log.info.bind(this.log);
    logLine('Browsing for Voltie chargers via mDNS (%d s)...', DISCOVERY_TIMEOUT_MS / 1000);
    let found;
    try {
      found = await discoverChargers(
        DISCOVERY_TIMEOUT_MS,
        (error) => this.log.warn('mDNS error during discovery: %s', errorText(error)),
      );
    } catch (error) {
      this.log.warn('mDNS discovery failed: %s', errorText(error));
      return;
    }
    logLine('Discovery finished: %d charger(s) found', found.length);

    await Promise.all(found.map(async (charger) => {
      if (coveredByManual(charger.address, charger.shortId)) {
        return;
      }
      const uuid = this.api.hap.uuid.generate(`voltie-discovered:${charger.shortId}`);
      if (handled.has(uuid)) {
        // Already running from this launch; a re-browse must not spawn a
        // second handler, but it does carry an address change over.
        const running = this.discoveredRunning.get(uuid);
        const cached = this.cachedAccessories.find((acc) => acc.UUID === uuid);
        const ctx = cached?.context.discovered as DiscoveredContext | undefined;
        if (running && ctx && ctx.host !== charger.address) {
          ctx.host = charger.address;
          running.updateHost(charger.address);
        }
        return;
      }
      // Only chargers with a working HTTP API become accessories; a charger
      // that advertises via mDNS but has the API disabled would otherwise sit
      // in HomeKit as a permanent "No Response" tile.
      const alreadyCached = this.cachedAccessories.some((cached) => cached.UUID === uuid);
      if (!alreadyCached) {
        const probe = await this.probeCharger(charger.address);
        if (probe !== 'ok') {
          const firstTime = this.skipped.get(charger.shortId) !== probe;
          this.skipped.set(charger.shortId, probe);
          const log = firstTime ? this.log.info.bind(this.log) : this.log.debug.bind(this.log);
          if (probe === 'auth') {
            log(
              'Found charger %s at %s, but its HTTP API requires authentication; skipping. '
              + 'Set the platform-level username/password, or add the charger manually with credentials.',
              charger.shortId.toUpperCase(), charger.address,
            );
          } else {
            log(
              'Found charger %s at %s, but its HTTP API is not reachable; skipping. '
              + 'Enable the HTTP API in the Voltie app to use it with HomeKit.',
              charger.shortId.toUpperCase(), charger.address,
            );
          }
          return;
        }
        this.skipped.delete(charger.shortId);
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
      return isAuthError(error) ? 'auth' : 'fail';
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
    const merged: ChargerConfigEntry = { ...entry };
    if (!(merged.username && merged.password)) {
      Object.assign(merged, this.defaultCredentials());
    }
    // Feature toggles set on the platform act as defaults for every charger,
    // so discovered chargers (which have no config entry) can enable the
    // optional services too; per-charger settings win.
    const featureKeys = [
      'pollInterval', 'idTag', 'currentControl', 'carConnectedSensor', 'faultSensor',
      'chargeCompleteSensor', 'accessLock', 'autostartSwitch', 'singlePhaseSwitch', 'rebootSwitch', 'rearLedLight',
      'outOfServiceSwitch', 'quietModeSwitch', 'dlmDynamicSwitch', 'ecoModeSwitch', 'greenModeSwitch', 'gridControlSwitch', 'keepLastSessionEnergy', 'eveHistory',
    ] as const;
    for (const key of featureKeys) {
      if (merged[key] === undefined && this.config[key] !== undefined) {
        (merged as Record<string, unknown>)[key] = this.config[key];
      }
    }
    return merged;
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

    const handler = new VoltieChargerAccessory(
      this,
      accessory,
      { ...entry, port, pollInterval, name },
      discovered && this.config.discovery !== false ? { onUnreachable: () => this.onDiscoveredUnreachable() } : {},
    );
    if (discovered) {
      this.discoveredRunning.set(uuid, handler);
    }
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
