import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  ChargerConfig,
  ChargerStatus,
  isCarConnected,
  isCharging,
  isFault,
  isSwitchedOn,
  errorText,
  isAuthError,
  VoltieApiError,
  VoltieClient,
} from './client';
import { join } from 'path';

import { ChargeCompleteDetector } from './chargeComplete';
import { EveEnergyHistory, removeEveHistory } from './eveHistory';
import type { ChargerConfigEntry, VoltieChargerPlatform } from './platform';
import { CURRENT_LIMIT_FALLBACK_MAX_A, CURRENT_LIMIT_MIN_A, START_NAME } from './settings';

interface ResolvedEntry extends ChargerConfigEntry {
  name: string;
  host?: string;
  port: number;
  pollInterval: number;
}

const REFRESH_AFTER_WRITE_MS = 1500;
// rear_led_set effects expire on the charger; ask for the maximum (spec 4.10.2).
const REAR_LED_DURATION_S = 3600;
const BRIGHTNESS_DEBOUNCE_MS = 500;
const FAILURES_BEFORE_UNREACHABLE = 2;

// Quiet mode = these three off together (the rear LED has its own lamp).
const QUIET_KEYS = ['conf_disp_enabled', 'conf_front_led_enabled', 'conf_buzzer_enabled'] as const;
// conf_dlm_mode values (spec 6.4): one field, so at most one mode is on.
const DLM_MODE_OFF = 0;
const DLM_MODE_DYNAMIC = 1;
const DLM_MODE_GRID_CONTROL = 4;

type ModeSwitchKey = 'dlmDynamicSwitch' | 'ecoModeSwitch' | 'greenModeSwitch' | 'gridControlSwitch';

/** One HomeKit switch per load management mode; each can be enabled on its
 * own in the plugin settings. */
const MODE_SWITCHES: ReadonlyArray<{ key: ModeSwitchKey; subtype: string; label: string; mode: number }> = [
  { key: 'dlmDynamicSwitch', subtype: 'dlm-dynamic', label: 'Dynamic Load', mode: DLM_MODE_DYNAMIC },
  { key: 'ecoModeSwitch', subtype: 'dlm-eco', label: 'Eco Mode', mode: 2 },
  { key: 'greenModeSwitch', subtype: 'dlm-green', label: 'Green Mode', mode: 3 },
  { key: 'gridControlSwitch', subtype: 'dlm-grid', label: 'Grid Control', mode: DLM_MODE_GRID_CONTROL },
];

interface LastSession {
  cdrId?: number;
  energy: number; // kWh
  final: boolean; // read from the closed CDR, not a live snapshot
}

export interface AccessoryHooks {
  /** Called once each time the charger turns unreachable. */
  onUnreachable?: () => void;
}

export class VoltieChargerAccessory {
  private client: VoltieClient;

  private readonly outletService: Service;
  private currentService?: Service;
  private carSensorService?: Service;
  private faultSensorService?: Service;
  private chargeCompleteService?: Service;
  private lockService?: Service;
  private autostartService?: Service;
  private singlePhaseService?: Service;
  private rebootService?: Service;
  private rearLedService?: Service;
  private outOfServiceService?: Service;
  private quietModeService?: Service;
  private readonly modeServices = new Map<number, Service>();
  private history?: EveEnergyHistory;

  private lastSession?: LastSession;
  private cdrFetchFor?: number;

  private status: ChargerStatus = {};
  private config: ChargerConfig = {};
  private consecutiveFailures = 0;
  private infoPopulated = false;
  private hasPolled = false;
  private stopped = false;
  // Bumped on every optimistic write and every poll start, so a poll response
  // that raced with a newer write (or a newer poll) is discarded instead of
  // snapping HomeKit back to stale values.
  private stateGeneration = 0;

  private lastLockState?: number;
  private readonly chargeComplete = new ChargeCompleteDetector();

  private brightnessTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private rearLedTimer?: NodeJS.Timeout;
  private rebootResetTimer?: NodeJS.Timeout;

  // The rear LED command is fire-and-forget on the charger (no readback), so
  // the lamp state lives here optimistically, persisted to the accessory
  // context so a restart does not forget the last set colour.
  private rearLed = { on: false, hue: 25, saturation: 100, brightness: 100 };

  constructor(
    private readonly platform: VoltieChargerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly entry: ResolvedEntry,
    private readonly hooks: AccessoryHooks = {},
  ) {
    this.client = new VoltieClient(entry.host!, entry.port, entry.username, entry.password);
    if (entry.idTag && !VoltieClient.isValidIdTag(entry.idTag)) {
      this.platform.log.warn(
        '[%s] idTag "%s" does not match the charger\'s format (8+ characters: letters, digits, _ or -); '
        + 'the charger will ignore it, and a start in RFID mode will fail',
        entry.name, entry.idTag,
      );
    }
    if (this.accessory.context.rearLed) {
      this.rearLed = { ...this.rearLed, ...this.accessory.context.rearLed };
    }
    this.lastSession = this.accessory.context.lastSession;

    const { Service: S, Characteristic: C } = this.platform;

    this.accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Voltie')
      .setCharacteristic(C.Model, 'Voltie Charger')
      // The real charger ID once known (cached from an earlier run), so the
      // serial number doesn't flip to host:port and back on every restart.
      .setCharacteristic(C.SerialNumber, this.accessory.context.chargerId ?? `${entry.host}:${entry.port}`);

    // Outlet: On = charging or charging enabled, OutletInUse = car connected.
    // Eve power/energy characteristics live here so Eve-style apps chart
    // consumption.
    this.outletService = this.accessory.getService(S.Outlet)
      ?? this.accessory.addService(S.Outlet, entry.name);
    this.outletService.setPrimaryService(true);
    this.outletService.getCharacteristic(C.On)
      .onGet(() => this.guarded(() => isSwitchedOn(this.status)))
      .onSet((value) => this.setCharging(value === true));
    this.outletService.getCharacteristic(C.OutletInUse)
      .onGet(() => this.guarded(() => isCarConnected(this.status)));
    for (const eveChar of Object.values(this.platform.eve)) {
      if (!this.outletService.testCharacteristic(eveChar)) {
        this.outletService.addCharacteristic(eveChar);
      }
    }

    this.setupCurrentService();
    this.setupCarSensor();
    this.setupFaultSensor();
    this.setupChargeCompleteSensor();
    this.setupAccessLock();
    this.setupAutostartSwitch();
    this.setupSinglePhaseSwitch();
    this.setupRebootSwitch();
    this.setupRearLed();
    this.outOfServiceService = this.setupConfigSwitch('out-of-service', 'Out of Service', this.entry.outOfServiceSwitch,
      () => this.config.conf_out_of_service === true,
      (on) => this.writeConfig({ conf_out_of_service: on }, `${on ? 'Took' : 'Returned'} the charger ${on ? 'out of' : 'to'} service`));
    this.quietModeService = this.setupConfigSwitch('quiet-mode', 'Quiet Mode', this.entry.quietModeSwitch,
      () => this.quietOn(), (on) => this.setQuietMode(on));
    for (const { key, subtype, label, mode } of MODE_SWITCHES) {
      const service = this.setupConfigSwitch(subtype, label, this.entry[key],
        () => this.config.conf_dlm_mode === mode, (on) => this.setLoadMode(mode, label, on));
      if (service) {
        this.modeServices.set(mode, service);
      }
    }
    this.setupEveHistory();
    // Linking the secondary services to the primary Outlet makes third-party
    // HomeKit apps (Eve, Controller) render the charger as one grouped block,
    // and ConfiguredName labels the sub-tiles in single-tile view.
    this.labelService(this.outletService, 'Charging');
    const secondaries: Array<[Service | undefined, string]> = [
      [this.currentService, 'Current'],
      [this.carSensorService, 'Car Connected'],
      [this.faultSensorService, 'Fault'],
      [this.chargeCompleteService, 'Charge Complete'],
      [this.lockService, 'RFID Lock'],
      [this.autostartService, 'Autostart'],
      [this.singlePhaseService, 'Single Phase'],
      [this.rebootService, 'Reboot'],
      [this.rearLedService, 'Rear LED'],
      [this.outOfServiceService, 'Out of Service'],
      [this.quietModeService, 'Quiet Mode'],
      ...MODE_SWITCHES.map(({ mode, label }): [Service | undefined, string] => [this.modeServices.get(mode), label]),
    ];
    for (const [service, label] of secondaries) {
      if (service) {
        this.outletService.addLinkedService(service);
        this.labelService(service, label);
      }
    }

    // "Identify" during pairing flashes the rear LED; unmistakably the right
    // charger, and harmless if the LED is disabled (the error is just logged).
    this.accessory.on('identify', () => {
      this.platform.log.info('[%s] Identify requested; flashing rear LED', this.entry.name);
      void this.client.setRearLed(1, 'FFFFFF', 3)
        .catch((error) => this.platform.log.debug('[%s] Identify LED flash failed: %s', this.entry.name, error));
    });

    void this.poll();
    const timer = setInterval(() => void this.poll(), this.entry.pollInterval * 1000);
    this.platform.api.on('shutdown', () => {
      this.stopped = true;
      clearInterval(timer);
      clearTimeout(this.brightnessTimer);
      clearTimeout(this.refreshTimer);
      clearTimeout(this.rearLedTimer);
      clearTimeout(this.rebootResetTimer);
      this.history?.stop();
    });
  }

  /** A discovered charger got a new DHCP lease: talk to the new address. */
  updateHost(host: string): void {
    if (host === this.entry.host) {
      return;
    }
    this.platform.log.info('[%s] Charger moved from %s to %s', this.entry.name, this.entry.host, host);
    this.entry.host = host;
    this.client = new VoltieClient(host, this.entry.port, this.entry.username, this.entry.password);
    this.stateGeneration += 1;
    void this.poll();
  }

  // ---- service setup ----

  private setupCurrentService(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.Lightbulb, 'charging-current');
    if (this.entry.currentControl === false) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.currentService = existing
      ?? this.accessory.addService(S.Lightbulb, `${this.entry.name} Current`, 'charging-current');
    this.currentService.getCharacteristic(C.On)
      .onGet(() => this.guarded(() => isSwitchedOn(this.status)))
      .onSet((value) => this.setCharging(value === true));
    this.currentService.getCharacteristic(C.Brightness)
      .onGet(() => this.guarded(() => this.percentFromAmps(this.displayedAmps())))
      .onSet((value) => this.setCurrentLimitPercent(value as number));
  }

  private setupCarSensor(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.ContactSensor, 'car-connected');
    if (this.entry.carConnectedSensor === false) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.carSensorService = existing
      ?? this.accessory.addService(S.ContactSensor, `${this.entry.name} Car Connected`, 'car-connected');
    // "Opened" = car connected, so HomeKit automations can trigger on plug-in.
    this.carSensorService.getCharacteristic(C.ContactSensorState)
      .onGet(() => this.guarded(() => this.carSensorValue()));
  }

  private setupFaultSensor(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.ContactSensor, 'fault');
    if (this.entry.faultSensor === false) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.faultSensorService = existing
      ?? this.accessory.addService(S.ContactSensor, `${this.entry.name} Fault`, 'fault');
    this.faultSensorService.getCharacteristic(C.ContactSensorState)
      .onGet(() => this.guarded(() => this.faultSensorValue()));
  }

  private setupChargeCompleteSensor(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.ContactSensor, 'charge-complete');
    if (this.entry.chargeCompleteSensor === false) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.chargeCompleteService = existing
      ?? this.accessory.addService(S.ContactSensor, `${this.entry.name} Charge Complete`, 'charge-complete');
    // Opens when the car stopped drawing on its own (typically full) while
    // still plugged in and charging is still enabled; a deliberate stop
    // (HomeKit, app, RFID) clears the enable flag first and must not fire.
    this.chargeCompleteService.getCharacteristic(C.ContactSensorState)
      .onGet(() => this.guarded(() => this.chargeCompleteValue()));
  }

  private setupAccessLock(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.LockMechanism, 'access-mode');
    if (this.entry.accessLock !== true) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.lockService = existing
      ?? this.accessory.addService(S.LockMechanism, `${this.entry.name} RFID Lock`, 'access-mode');
    this.lockService.getCharacteristic(C.LockCurrentState)
      .onGet(() => this.guarded(() => this.lockStateValue()));
    this.lockService.getCharacteristic(C.LockTargetState)
      .onGet(() => this.guarded(() => this.lockStateValue()))
      .onSet((value) => this.setAccessMode(value === this.platform.Characteristic.LockTargetState.SECURED));
  }

  private setupAutostartSwitch(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.Switch, 'autostart');
    if (this.entry.autostartSwitch !== true) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.autostartService = existing
      ?? this.accessory.addService(S.Switch, `${this.entry.name} Autostart`, 'autostart');
    this.autostartService.getCharacteristic(C.On)
      .onGet(() => this.guarded(() => this.autostartOn()))
      .onSet((value) => this.setAutostart(value === true));
  }

  /**
   * 'auto' (default): shown only once the charger reports phase-switching
   * support; 'show'/'hide' (or true/false) override in either direction.
   */
  private singlePhaseMode(): 'show' | 'hide' | 'auto' {
    const value = this.entry.singlePhaseSwitch;
    if (value === true || value === 'show') {
      return 'show';
    }
    if (value === false || value === 'hide') {
      return 'hide';
    }
    return 'auto';
  }

  private singlePhaseSupported(): 'yes' | 'no' | 'unknown' {
    // Forcing single phase is meaningless on a single-phase installation.
    if (typeof this.status.phases === 'number' && this.status.phases < 3) {
      return 'no';
    }
    const conf = this.config.conf_force_single_phase;
    if (conf === 0 || conf === 1) {
      return 'yes';
    }
    if (conf === 2) {
      return 'no';
    }
    // 3 = transient "unknown" (e.g. right after charger boot) and a missing
    // field both mean "don't know yet"; visibility must not flap on it,
    // because every remove/add cycle silently breaks HomeKit automations
    // that reference the switch.
    return 'unknown';
  }

  private setupSinglePhaseSwitch(): void {
    const mode = this.singlePhaseMode();
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'single-phase');
    if (mode === 'hide') {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    // 'auto' with a cached service means it was supported last time; keep it
    // alive so a restart doesn't flap the accessory before the first poll.
    if (mode === 'show' || existing) {
      this.attachSinglePhaseService();
    }
  }

  private attachSinglePhaseService(): void {
    if (this.singlePhaseService) {
      return;
    }
    const { Service: S, Characteristic: C } = this.platform;
    this.singlePhaseService = this.accessory.getServiceById(S.Switch, 'single-phase')
      ?? this.accessory.addService(S.Switch, `${this.entry.name} Single Phase`, 'single-phase');
    this.singlePhaseService.getCharacteristic(C.On)
      .onGet(() => this.guarded(() => this.config.conf_force_single_phase === 1))
      .onSet((value) => this.setForceSinglePhase(value === true));
    this.outletService.addLinkedService(this.singlePhaseService);
    this.labelService(this.singlePhaseService, 'Single Phase');
  }

  private syncSinglePhaseVisibility(): void {
    if (this.singlePhaseMode() !== 'auto') {
      return;
    }
    const supported = this.singlePhaseSupported();
    if (supported === 'yes' && !this.singlePhaseService) {
      this.platform.log.info('[%s] Phase switching supported; adding Single Phase switch', this.entry.name);
      this.attachSinglePhaseService();
    } else if (supported === 'no' && this.singlePhaseService) {
      this.platform.log.info('[%s] Phase switching not supported; removing Single Phase switch', this.entry.name);
      this.accessory.removeService(this.singlePhaseService);
      this.singlePhaseService = undefined;
    }
  }

  private setupRebootSwitch(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.Switch, 'reboot');
    if (this.entry.rebootSwitch !== true) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.rebootService = existing
      ?? this.accessory.addService(S.Switch, `${this.entry.name} Reboot`, 'reboot');
    this.rebootService.getCharacteristic(C.On)
      .onGet(() => false)
      .onSet((value) => this.triggerReboot(value === true));
  }

  private setupRearLed(): void {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.Lightbulb, 'rear-led');
    if (this.entry.rearLedLight !== true) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.rearLedService = existing
      ?? this.accessory.addService(S.Lightbulb, `${this.entry.name} Rear LED`, 'rear-led');
    this.rearLedService.getCharacteristic(C.On)
      .onGet(() => this.guarded(() => this.rearLedOn()))
      .onSet((value) => this.setRearLedEnabled(value === true));
    this.rearLedService.getCharacteristic(C.Brightness)
      .onGet(() => this.rearLed.brightness)
      .onSet((value) => {
        this.rearLed.brightness = value as number;
        this.sendRearLed();
      });
    this.rearLedService.getCharacteristic(C.Hue)
      .onGet(() => this.rearLed.hue)
      .onSet((value) => {
        this.rearLed.hue = value as number;
        this.sendRearLed();
      });
    this.rearLedService.getCharacteristic(C.Saturation)
      .onGet(() => this.rearLed.saturation)
      .onSet((value) => {
        this.rearLed.saturation = value as number;
        this.sendRearLed();
      });
  }

  /** A Switch bound to charger config: added when enabled in the plugin
   * settings, removed (with its cached state) when disabled. */
  private setupConfigSwitch(
    subtype: string,
    label: string,
    enabled: boolean | undefined,
    read: () => boolean,
    write: (on: boolean) => Promise<void>,
  ): Service | undefined {
    const { Service: S, Characteristic: C } = this.platform;
    const existing = this.accessory.getServiceById(S.Switch, subtype);
    if (enabled !== true) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    const service = existing ?? this.accessory.addService(S.Switch, `${this.entry.name} ${label}`, subtype);
    service.getCharacteristic(C.On)
      .onGet(() => this.guarded(read))
      .onSet((value) => write(value === true));
    return service;
  }

  private setupEveHistory(): void {
    if (this.entry.eveHistory !== true) {
      removeEveHistory(this.accessory);
      return;
    }
    const file = join(this.platform.api.user.storagePath(), 'voltie-charger', `history-${this.accessory.UUID}.json`);
    this.history = new EveEnergyHistory(this.platform.api, this.accessory, file, this.platform.log);
  }

  /**
   * Default ConfiguredName carries the charger name too ("Voltie 77ED RFID
   * Lock"), because push notifications show only room + service name, and
   * with several chargers the bare label was ambiguous. Values renamed by
   * the user in the Home app are left alone; our own earlier short-label
   * defaults are migrated once.
   */
  private labelService(service: Service, label: string): void {
    const { ConfiguredName } = this.platform.Characteristic;
    service.addOptionalCharacteristic(ConfiguredName);
    const current = service.getCharacteristic(ConfiguredName).value;
    const desired = label === 'Charging' ? this.entry.name : `${this.entry.name} ${label}`;
    // Remember what we set, so renaming the charger in the plugin config
    // carries through, while a rename made in the Home app (which no longer
    // matches our last value) is still left alone.
    const autoNames: Record<string, string> = this.accessory.context.autoNames ?? {};
    const key = service.subtype ?? label;
    if (!current || current === label || current === autoNames[key]) {
      service.updateCharacteristic(ConfiguredName, desired);
      autoNames[key] = desired;
      this.accessory.context.autoNames = autoNames;
    }
  }

  // ---- HomeKit -> charger ----

  private async setCharging(on: boolean): Promise<void> {
    try {
      this.stateGeneration += 1;
      if (on) {
        await this.client.start(START_NAME, this.entry.idTag);
      } else {
        await this.client.stop();
      }
      this.platform.log.info('[%s] %s charging', this.entry.name, on ? 'Started' : 'Stopped');
    } catch (error) {
      this.platform.log.error('[%s] Failed to %s charging: %s', this.entry.name, on ? 'start' : 'stop', errorText(error));
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private setCurrentLimitPercent(percent: number): void {
    const amps = this.ampsFromPercent(percent);
    // HomeKit sliders emit a burst of values while dragging; only the last one
    // may hit the charger's EEPROM-backed config.
    clearTimeout(this.brightnessTimer);
    this.brightnessTimer = setTimeout(() => {
      void (async () => {
        try {
          this.stateGeneration += 1;
          await this.client.setConfig({ conf_current_limit: amps });
          this.config.conf_current_limit = amps;
          this.platform.log.info('[%s] Current limit set to %d A', this.entry.name, amps);
        } catch (error) {
          this.platform.log.error('[%s] Failed to set current limit: %s', this.entry.name, errorText(error));
        } finally {
          this.scheduleRefresh();
        }
      })();
    }, BRIGHTNESS_DEBOUNCE_MS);
  }

  private async setAccessMode(rfidRequired: boolean): Promise<void> {
    try {
      this.stateGeneration += 1;
      await this.client.setConfig({ conf_access_mode: rfidRequired ? 1 : 0 });
      this.config.conf_access_mode = rfidRequired ? 1 : 0;
      this.lockService?.updateCharacteristic(
        this.platform.Characteristic.LockCurrentState,
        this.lockStateValue(),
      );
    } catch (error) {
      this.platform.log.error('[%s] Failed to set access mode: %s', this.entry.name, errorText(error));
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private async setAutostart(enabled: boolean): Promise<void> {
    try {
      this.stateGeneration += 1;
      // Current firmware validates this key as a JSON boolean on write while
      // still reporting 0/1 on read (verified live); ancient firmware wanted
      // 0/1, so fall back to that on a rejected write.
      try {
        await this.client.setConfig({ conf_autostart_enabled: enabled });
      } catch (error) {
        if (error instanceof VoltieApiError) {
          await this.client.setConfig({ conf_autostart_enabled: enabled ? 1 : 0 });
        } else {
          throw error;
        }
      }
      this.config.conf_autostart_enabled = enabled ? 1 : 0;
    } catch (error) {
      this.platform.log.error('[%s] Failed to set autostart: %s', this.entry.name, errorText(error));
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private async setForceSinglePhase(enabled: boolean): Promise<void> {
    try {
      this.stateGeneration += 1;
      await this.client.setConfig({ conf_force_single_phase: enabled ? 1 : 0 });
      this.config.conf_force_single_phase = enabled ? 1 : 0;
    } catch (error) {
      this.platform.log.error('[%s] Failed to set single-phase mode: %s', this.entry.name, errorText(error));
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private async triggerReboot(on: boolean): Promise<void> {
    if (!on) {
      return;
    }
    try {
      await this.client.reboot();
      this.platform.log.warn('[%s] Charger reboot requested from HomeKit', this.entry.name);
    } catch (error) {
      this.platform.log.error('[%s] Failed to reboot charger: %s', this.entry.name, errorText(error));
      throw this.communicationError();
    } finally {
      // Momentary switch: flip back off after the request settled, so a slow
      // (>1 s) but successful POST can't leave the tile stuck on.
      clearTimeout(this.rebootResetTimer);
      this.rebootResetTimer = setTimeout(() => {
        this.rebootService?.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 1000);
    }
  }

  /** The lamp's On state is the charger's persistent LED-enable flag; older
   * firmwares without the field fall back to the optimistic local state. */
  private rearLedOn(): boolean {
    const enabled = this.config.conf_rear_led_enabled;
    return typeof enabled === 'boolean' ? enabled : this.rearLed.on;
  }

  private async setRearLedEnabled(on: boolean): Promise<void> {
    this.rearLed.on = on;
    if (!on) {
      clearTimeout(this.rearLedTimer);
    }
    if (typeof this.config.conf_rear_led_enabled !== 'boolean') {
      // Older firmware: keep the transient-override behaviour.
      this.sendRearLed();
      return;
    }
    try {
      this.stateGeneration += 1;
      await this.client.setConfig({ conf_rear_led_enabled: on });
      this.config.conf_rear_led_enabled = on;
      if (!on) {
        // An active colour override outranks the disable flag in the firmware
        // (it would keep glowing for up to an hour); cancel it explicitly.
        await this.client.setRearLed(0, '000000', 1).catch(() => undefined);
      }
      this.accessory.context.rearLed = { ...this.rearLed };
      this.platform.log.info('[%s] Rear LED %s', this.entry.name, on ? 'enabled' : 'disabled');
    } catch (error) {
      this.rearLed.on = !on;
      this.platform.log.error('[%s] Failed to %s rear LED: %s', this.entry.name, on ? 'enable' : 'disable', errorText(error));
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private sendRearLed(): void {
    // HomeKit sets On/Brightness/Hue/Saturation as separate writes in quick
    // succession; coalesce them into one command.
    clearTimeout(this.rearLedTimer);
    this.rearLedTimer = setTimeout(() => {
      const on = this.rearLedOn();
      this.rearLed.on = on;
      const { hue, saturation, brightness } = this.rearLed;
      this.accessory.context.rearLed = { ...this.rearLed };
      const color = hsvToRgbHex(hue, saturation);
      const ensureEnabled = on && this.config.conf_rear_led_enabled === false
        ? this.client.setConfig({ conf_rear_led_enabled: true }).then(() => {
          this.stateGeneration += 1;
          this.config.conf_rear_led_enabled = true;
        })
        : Promise.resolve();
      void ensureEnabled
        .then(() => this.client.setRearLed(on ? Math.max(1, brightness) / 100 : 0, color, REAR_LED_DURATION_S))
        .then(() => this.platform.log.debug(
          '[%s] Rear LED set: on=%s color=%s brightness=%d%%',
          this.entry.name, on, color, brightness,
        ))
        .catch((error) => {
          this.platform.log.error('[%s] Failed to set rear LED: %s', this.entry.name, errorText(error));
          // Only the old-firmware fallback owns the On state locally; with the
          // enabled flag the next poll shows the truth anyway.
          if (typeof this.config.conf_rear_led_enabled !== 'boolean' && this.rearLed.on) {
            this.rearLed.on = false;
            this.rearLedService?.updateCharacteristic(this.platform.Characteristic.On, false);
          }
        })
        ;
      // No keep-alive: the colour override expires after the firmware's hour
      // on purpose, returning the LED to the charger's own behaviour — a
      // forever-refreshed override silently overrode the Voltie app's LED
      // controls too.
    }, BRIGHTNESS_DEBOUNCE_MS);
  }

  /** One PUT /config with optimistic local update and readback. */
  private async writeConfig(values: Record<string, unknown>, done: string): Promise<void> {
    try {
      this.stateGeneration += 1;
      await this.client.setConfig(values);
      Object.assign(this.config, values);
      this.platform.log.info('[%s] %s', this.entry.name, done);
    } catch (error) {
      this.platform.log.error('[%s] Failed to change setting (%s): %s',
        this.entry.name, Object.keys(values).join(', '), errorText(error));
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private quietKeys(): Array<typeof QUIET_KEYS[number]> {
    return QUIET_KEYS.filter((key) => typeof this.config[key] === 'boolean');
  }

  private quietOn(): boolean {
    const keys = this.quietKeys();
    return keys.length > 0 && keys.every((key) => this.config[key] === false);
  }

  /** On: display, front LED and buzzer off. Off: restores what was on
   * before, so a display the user keeps off on purpose stays off. */
  private async setQuietMode(on: boolean): Promise<void> {
    const keys = this.quietKeys();
    const values: Record<string, boolean> = {};
    if (on) {
      if (!this.quietOn()) {
        this.accessory.context.quietRestore = Object.fromEntries(keys.map((key) => [key, this.config[key]]));
      }
      keys.forEach((key) => (values[key] = false));
    } else {
      const saved: Record<string, unknown> = this.accessory.context.quietRestore ?? {};
      keys.forEach((key) => (values[key] = saved[key] !== false));
      // All three were off before too: "quiet off" must still turn them on.
      if (keys.every((key) => values[key] === false)) {
        keys.forEach((key) => (values[key] = true));
      }
    }
    await this.writeConfig(values, `Quiet mode ${on ? 'on (display, front LED and buzzer off)' : 'off'}`);
    if (!on) {
      delete this.accessory.context.quietRestore;
    }
  }

  /**
   * On: switch the charger to this mode (the other mode tiles go off, it is a
   * single setting). Off: back to the mode that was active before, the same
   * way the Voltie app would leave it. Without a remembered mode, the solar
   * modes fall back to Dynamic, Dynamic and Grid Control to off.
   */
  private async setLoadMode(mode: number, label: string, on: boolean): Promise<void> {
    const current = this.config.conf_dlm_mode;
    if (on) {
      if (current === mode) {
        return;
      }
      if (typeof current === 'number') {
        this.accessory.context.dlmRestoreMode = current;
      }
      await this.writeConfig({ conf_dlm_mode: mode }, `${label} on`);
      this.pushModeSwitches();
      if (mode !== DLM_MODE_GRID_CONTROL) {
        void this.warnIfNoMeter(label);
      }
      return;
    }
    if (current !== mode) {
      return; // already another mode; nothing to undo
    }
    const saved = this.accessory.context.dlmRestoreMode;
    const fallback = mode === DLM_MODE_DYNAMIC || mode === DLM_MODE_GRID_CONTROL ? DLM_MODE_OFF : DLM_MODE_DYNAMIC;
    const restore = typeof saved === 'number' && saved !== mode ? saved : fallback;
    const restoredLabel = MODE_SWITCHES.find((entry) => entry.mode === restore)?.label ?? 'load management off';
    await this.writeConfig({ conf_dlm_mode: restore }, `${label} off (now: ${restoredLabel})`);
    delete this.accessory.context.dlmRestoreMode;
    this.pushModeSwitches();
    if (restore === DLM_MODE_OFF) {
      this.platform.log.warn(
        '[%s] Load management is now off: the charger no longer limits its current to the house main fuse',
        this.entry.name,
      );
    }
  }

  private pushModeSwitches(): void {
    for (const [mode, service] of this.modeServices) {
      service.updateCharacteristic(this.platform.Characteristic.On, this.config.conf_dlm_mode === mode);
    }
  }

  /** Dynamic, Eco and Green need an external meter (SensorBox,
   * VoltieMeter); without one the charger accepts the mode but has nothing
   * to regulate on. Grid Control works without a meter. */
  private async warnIfNoMeter(label: string): Promise<void> {
    try {
      const power = await this.client.getPower();
      if (power.dlm_valid === false) {
        this.platform.log.warn(
          '[%s] %s is on, but the charger reports no external meter data; '
          + 'this mode needs a SensorBox or VoltieMeter at the grid connection',
          this.entry.name, label,
        );
      }
    } catch (error) {
      this.platform.log.debug('[%s] Meter check after enabling %s failed: %s', this.entry.name, label, errorText(error));
    }
  }

  /** Session energy for the Eve "total" field: the live session, or with
   * keepLastSessionEnergy the last finished one instead of 0 between them. */
  private sessionEnergy(): number {
    // Watt-hour resolution, the characteristic's minStep.
    const kwh = (value: number) => Math.round(Math.max(0, value) * 1000) / 1000;
    const live = this.status.cdr?.chg_energy;
    if (typeof live === 'number') {
      return kwh(live);
    }
    if (this.entry.keepLastSessionEnergy !== false && this.lastSession) {
      return kwh(this.lastSession.energy);
    }
    return 0;
  }

  private trackSessionEnergy(): void {
    const cdr = this.status.cdr;
    if (cdr && typeof cdr.chg_energy === 'number') {
      this.lastSession = { cdrId: cdr.cdr_id, energy: cdr.chg_energy, final: false };
      this.accessory.context.lastSession = this.lastSession;
      return;
    }
    if (this.entry.keepLastSessionEnergy === false) {
      return;
    }
    // No open session: read the closing value of the last record once (the
    // live snapshot misses the last poll interval, and after a restart there
    // is none at all).
    const lastId = this.status.last_cdr;
    if (typeof lastId !== 'number' || lastId <= 0 || this.cdrFetchFor === lastId) {
      return;
    }
    if (this.lastSession?.final && this.lastSession.cdrId === lastId) {
      return;
    }
    this.cdrFetchFor = lastId;
    this.client.getCdr(lastId)
      .then((record) => {
        if (record && typeof record.chg_energy === 'number') {
          this.lastSession = { cdrId: lastId, energy: record.chg_energy, final: true };
          this.accessory.context.lastSession = this.lastSession;
          this.outletService.updateCharacteristic(this.platform.eve.TotalConsumption, this.sessionEnergy());
        }
      })
      .catch((error) => this.platform.log.debug('[%s] Reading CDR %d failed: %s', this.entry.name, lastId, errorText(error)));
  }

  // ---- polling ----

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), REFRESH_AFTER_WRITE_MS);
  }

  private async poll(): Promise<void> {
    // No requests after Homebridge shut down (a refresh or host change can
    // still be queued at that point).
    if (this.stopped) {
      return;
    }
    const generation = ++this.stateGeneration;
    try {
      const [status, config] = await Promise.all([
        this.client.getStatus(),
        this.client.getConfig(),
      ]);
      if (this.consecutiveFailures >= FAILURES_BEFORE_UNREACHABLE) {
        this.platform.log.info('[%s] Charger is reachable again', this.entry.name);
      }
      this.consecutiveFailures = 0;
      if (generation !== this.stateGeneration) {
        return;
      }
      this.status = status;
      // Merge instead of replace: a field missing from one response (e.g.
      // right after charger boot) keeps its last known value, so a single
      // partial read cannot flip lock/switch states and spam notifications.
      this.config = { ...this.config, ...config };
      this.hasPolled = true;
      this.trackSessionEnergy();
      this.history?.addSample(Math.max(0, (status.charge_power ?? 0) * 1000));
      this.pushState();
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1 && isAuthError(error)) {
        this.platform.log.warn(
          '[%s] The charger rejected the credentials; check the username/password in the plugin config',
          this.entry.name,
        );
      }
      if (this.consecutiveFailures === FAILURES_BEFORE_UNREACHABLE) {
        this.hooks.onUnreachable?.();
        if (error instanceof VoltieApiError && error.code === 24) {
          this.platform.log.warn(
            '[%s] Charger firmware is too old for this plugin (HTTP API endpoint missing): %s',
            this.entry.name, error.message,
          );
        } else {
          this.platform.log.warn('[%s] Charger unreachable: %s', this.entry.name, errorText(error));
          this.platform.log.debug('[%s] Unreachable detail: %s', this.entry.name, error instanceof Error ? error.stack : error);
        }
      }
    }
  }

  private pushState(): void {
    const { Characteristic: C } = this.platform;
    const charging = isSwitchedOn(this.status);

    this.outletService.updateCharacteristic(C.On, charging);
    this.outletService.updateCharacteristic(C.OutletInUse, isCarConnected(this.status));
    this.outletService.updateCharacteristic(
      this.platform.eve.CurrentConsumption,
      Math.max(0, (this.status.charge_power ?? 0) * 1000),
    );
    this.outletService.updateCharacteristic(
      this.platform.eve.TotalConsumption,
      this.sessionEnergy(),
    );
    this.outletService.updateCharacteristic(
      this.platform.eve.Voltage,
      Math.max(0, this.status.mains_voltage ?? 0),
    );
    this.outletService.updateCharacteristic(
      this.platform.eve.ElectricCurrent,
      Math.max(0, this.status.charge_current ?? 0),
    );

    this.currentService?.updateCharacteristic(C.On, charging);
    this.currentService?.updateCharacteristic(
      C.Brightness,
      this.percentFromAmps(this.displayedAmps()),
    );
    this.carSensorService?.updateCharacteristic(C.ContactSensorState, this.carSensorValue());
    this.faultSensorService?.updateCharacteristic(C.ContactSensorState, this.faultSensorValue());
    this.updateChargeComplete();
    this.chargeCompleteService?.updateCharacteristic(C.ContactSensorState, this.chargeCompleteValue());
    this.lockService?.updateCharacteristic(C.LockCurrentState, this.lockStateValue());
    this.lockService?.updateCharacteristic(C.LockTargetState, this.lockStateValue());
    this.autostartService?.updateCharacteristic(C.On, this.autostartOn());
    this.rearLed.on = this.rearLedOn();
    this.rearLedService?.updateCharacteristic(C.On, this.rearLed.on);
    try {
      this.syncSinglePhaseVisibility();
    } catch (error) {
      this.platform.log.error('[%s] Failed to update Single Phase switch visibility: %s', this.entry.name, errorText(error));
    }
    this.singlePhaseService?.updateCharacteristic(C.On, this.config.conf_force_single_phase === 1);
    this.outOfServiceService?.updateCharacteristic(C.On, this.config.conf_out_of_service === true);
    this.quietModeService?.updateCharacteristic(C.On, this.quietOn());
    this.pushModeSwitches();

    this.populateAccessoryInfo();
  }

  private populateAccessoryInfo(): void {
    if (this.infoPopulated) {
      return;
    }
    const { Service: S, Characteristic: C } = this.platform;
    if (typeof this.status.charger_id !== 'string' || !this.status.charger_id) {
      return;
    }
    const info = this.accessory.getService(S.AccessoryInformation)!;
    info.updateCharacteristic(C.SerialNumber, this.status.charger_id);
    this.accessory.context.chargerId = this.status.charger_id;
    const version = formatSwVersion(this.status.sw_ver);
    if (version) {
      info.updateCharacteristic(C.FirmwareRevision, version);
    }
    this.infoPopulated = true;
  }

  // ---- value mapping ----

  private updateChargeComplete(): void {
    if (this.chargeComplete.update(this.status)) {
      this.platform.log.info('[%s] Charging finished (car stopped drawing while power is still offered)', this.entry.name);
    }
  }

  private chargeCompleteValue(): number {
    const { ContactSensorState } = this.platform.Characteristic;
    return this.chargeComplete.isComplete
      ? ContactSensorState.CONTACT_NOT_DETECTED
      : ContactSensorState.CONTACT_DETECTED;
  }

  private carSensorValue(): number {
    const { ContactSensorState } = this.platform.Characteristic;
    return isCarConnected(this.status)
      ? ContactSensorState.CONTACT_NOT_DETECTED
      : ContactSensorState.CONTACT_DETECTED;
  }

  private faultSensorValue(): number {
    const { ContactSensorState } = this.platform.Characteristic;
    return isFault(this.status)
      ? ContactSensorState.CONTACT_NOT_DETECTED
      : ContactSensorState.CONTACT_DETECTED;
  }

  private autostartOn(): boolean {
    const v = this.config.conf_autostart_enabled as unknown;
    return v === 1 || v === true;
  }

  private lockStateValue(): number {
    const { LockCurrentState } = this.platform.Characteristic;
    const mode = this.config.conf_access_mode;
    if (mode === 1) {
      this.lastLockState = LockCurrentState.SECURED;
    } else if (mode === 0) {
      this.lastLockState = LockCurrentState.UNSECURED;
    }
    // Transient/unknown values keep the previous state.
    return this.lastLockState ?? LockCurrentState.UNSECURED;
  }

  /**
   * The dimmer shows what the charger is actually OFFERING while a session
   * runs (the config limit can sit dormant until the next write), and the
   * stored config limit otherwise. Writes always go to conf_current_limit.
   */
  private displayedAmps(): number | undefined {
    const offered = this.status.current_offered;
    if (isCharging(this.status) && typeof offered === 'number' && offered >= CURRENT_LIMIT_MIN_A) {
      return offered;
    }
    return this.config.conf_current_limit;
  }

  private maxAmps(): number {
    const hwLimit = this.status.current_hw_limit;
    if (typeof hwLimit === 'number' && hwLimit > CURRENT_LIMIT_MIN_A) {
      return Math.min(hwLimit, CURRENT_LIMIT_FALLBACK_MAX_A);
    }
    return CURRENT_LIMIT_FALLBACK_MAX_A;
  }

  private percentFromAmps(amps: number | undefined): number {
    const max = this.maxAmps();
    if (max <= CURRENT_LIMIT_MIN_A) {
      return 100;
    }
    const value = typeof amps === 'number' ? amps : max;
    const clamped = Math.min(max, Math.max(CURRENT_LIMIT_MIN_A, value));
    return Math.round(((clamped - CURRENT_LIMIT_MIN_A) / (max - CURRENT_LIMIT_MIN_A)) * 100);
  }

  private ampsFromPercent(percent: number): number {
    const max = this.maxAmps();
    const clamped = Math.min(100, Math.max(0, percent));
    return Math.round(CURRENT_LIMIT_MIN_A + ((max - CURRENT_LIMIT_MIN_A) * clamped) / 100);
  }

  // ---- plumbing ----

  private guarded<T extends CharacteristicValue>(getter: () => T): T {
    // Before the first successful poll there is no real state to report;
    // answering with defaults here made HomeKit send phantom lock/switch
    // change notifications on every child-bridge restart.
    if (!this.hasPolled || this.consecutiveFailures >= FAILURES_BEFORE_UNREACHABLE) {
      throw this.communicationError();
    }
    return getter();
  }

  private communicationError(): Error {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }
}

export function hsvToRgbHex(hue: number, saturation: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(100, Math.max(0, saturation)) / 100;
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  let rgb: [number, number, number];
  if (h < 60) {
    rgb = [c, x, 0];
  } else if (h < 120) {
    rgb = [x, c, 0];
  } else if (h < 180) {
    rgb = [0, c, x];
  } else if (h < 240) {
    rgb = [0, x, c];
  } else if (h < 300) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }
  return rgb
    .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Decode the decimal-packed software version (e.g. 1003042 -> '1.3.42'). */
export function formatSwVersion(raw: unknown): string | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const major = Math.floor(value / 1_000_000);
  const minor = Math.floor(value / 1_000) % 1_000;
  const patch = value % 1_000;
  return `${major}.${minor}.${patch}`;
}
