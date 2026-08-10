import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  ChargerConfig,
  ChargerStatus,
  isCarConnected,
  isFault,
  isSwitchedOn,
  VoltieApiError,
  VoltieClient,
} from './client';
import type { ChargerConfigEntry, VoltieChargerPlatform } from './platform';
import { CURRENT_LIMIT_FALLBACK_MAX_A, CURRENT_LIMIT_MIN_A, REAR_LED_KEEPALIVE_MS, START_NAME } from './settings';

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

export class VoltieChargerAccessory {
  private readonly client: VoltieClient;

  private readonly outletService: Service;
  private currentService?: Service;
  private carSensorService?: Service;
  private faultSensorService?: Service;
  private lockService?: Service;
  private autostartService?: Service;
  private singlePhaseService?: Service;
  private rebootService?: Service;
  private rearLedService?: Service;

  private status: ChargerStatus = {};
  private config: ChargerConfig = {};
  private consecutiveFailures = 0;
  private infoPopulated = false;
  // Bumped on every optimistic write and every poll start, so a poll response
  // that raced with a newer write (or a newer poll) is discarded instead of
  // snapping HomeKit back to stale values.
  private stateGeneration = 0;

  private brightnessTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private rearLedTimer?: NodeJS.Timeout;
  private rearLedKeepAliveTimer?: NodeJS.Timeout;
  private rebootResetTimer?: NodeJS.Timeout;

  // The rear LED command is fire-and-forget on the charger (no readback), so
  // the lamp state lives here, optimistically.
  private rearLed = { on: false, hue: 25, saturation: 100, brightness: 100 };

  constructor(
    private readonly platform: VoltieChargerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly entry: ResolvedEntry,
  ) {
    this.client = new VoltieClient(entry.host!, entry.port, entry.username, entry.password);

    const { Service: S, Characteristic: C } = this.platform;

    this.accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Voltie')
      .setCharacteristic(C.Model, 'Voltie Charger')
      .setCharacteristic(C.SerialNumber, `${entry.host}:${entry.port}`);

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
    this.setupAccessLock();
    this.setupAutostartSwitch();
    this.setupSinglePhaseSwitch();
    this.setupRebootSwitch();
    this.setupRearLed();
    // Linking the secondary services to the primary Outlet makes third-party
    // HomeKit apps (Eve, Controller) render the charger as one grouped block,
    // and ConfiguredName labels the sub-tiles in single-tile view.
    this.labelService(this.outletService, 'Charging');
    const secondaries: Array<[Service | undefined, string]> = [
      [this.currentService, 'Current'],
      [this.carSensorService, 'Car Connected'],
      [this.faultSensorService, 'Fault'],
      [this.lockService, 'RFID Lock'],
      [this.autostartService, 'Autostart'],
      [this.singlePhaseService, 'Single Phase'],
      [this.rebootService, 'Reboot'],
      [this.rearLedService, 'Rear LED'],
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
      clearInterval(timer);
      clearTimeout(this.brightnessTimer);
      clearTimeout(this.refreshTimer);
      clearTimeout(this.rearLedTimer);
      clearTimeout(this.rearLedKeepAliveTimer);
      clearTimeout(this.rebootResetTimer);
    });
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
      .onGet(() => this.guarded(() => this.percentFromAmps(this.config.conf_current_limit)))
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
      .onGet(() => this.guarded(() => this.config.conf_autostart_enabled === 1))
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
      .onGet(() => this.rearLed.on)
      .onSet((value) => {
        this.rearLed.on = value === true;
        this.sendRearLed();
      });
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

  /** Set ConfiguredName once so single-tile sub-tiles get short labels while
   * user renames from the Home app survive restarts. */
  private labelService(service: Service, label: string): void {
    const { ConfiguredName } = this.platform.Characteristic;
    service.addOptionalCharacteristic(ConfiguredName);
    if (!service.getCharacteristic(ConfiguredName).value) {
      service.updateCharacteristic(ConfiguredName, label);
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
      this.platform.log.error('[%s] Failed to %s charging: %s', this.entry.name, on ? 'start' : 'stop', error);
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
          this.platform.log.error('[%s] Failed to set current limit: %s', this.entry.name, error);
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
      this.platform.log.error('[%s] Failed to set access mode: %s', this.entry.name, error);
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  private async setAutostart(enabled: boolean): Promise<void> {
    try {
      this.stateGeneration += 1;
      await this.client.setConfig({ conf_autostart_enabled: enabled ? 1 : 0 });
      this.config.conf_autostart_enabled = enabled ? 1 : 0;
    } catch (error) {
      this.platform.log.error('[%s] Failed to set autostart: %s', this.entry.name, error);
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
      this.platform.log.error('[%s] Failed to set single-phase mode: %s', this.entry.name, error);
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
      this.platform.log.error('[%s] Failed to reboot charger: %s', this.entry.name, error);
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

  private sendRearLed(): void {
    // HomeKit sets On/Brightness/Hue/Saturation as separate writes in quick
    // succession; coalesce them into one command.
    clearTimeout(this.rearLedTimer);
    this.rearLedTimer = setTimeout(() => {
      const { on, hue, saturation, brightness } = this.rearLed;
      const color = hsvToRgbHex(hue, saturation);
      void this.client
        .setRearLed(on ? Math.max(1, brightness) / 100 : 0, color, REAR_LED_DURATION_S)
        .then(() => this.platform.log.debug(
          '[%s] Rear LED set: on=%s color=%s brightness=%d%%',
          this.entry.name, on, color, brightness,
        ))
        .catch((error) => {
          this.platform.log.error('[%s] Failed to set rear LED: %s', this.entry.name, error);
          if (this.rearLed.on) {
            // Roll the tile back so a rejected command isn't shown as lit.
            this.rearLed.on = false;
            this.rearLedService?.updateCharacteristic(this.platform.Characteristic.On, false);
          }
        })
        .finally(() => {
          // The firmware expires the effect after an hour; while the lamp is
          // on, refresh it (also retries after a failed send).
          clearTimeout(this.rearLedKeepAliveTimer);
          if (this.rearLed.on) {
            this.rearLedKeepAliveTimer = setTimeout(() => this.sendRearLed(), REAR_LED_KEEPALIVE_MS);
          }
        });
    }, BRIGHTNESS_DEBOUNCE_MS);
  }

  // ---- polling ----

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), REFRESH_AFTER_WRITE_MS);
  }

  private async poll(): Promise<void> {
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
      this.config = config;
      this.pushState();
    } catch (error) {
      this.consecutiveFailures += 1;
      if (
        this.consecutiveFailures === 1
        && error instanceof VoltieApiError
        && error.message.includes('Authentication')
      ) {
        this.platform.log.warn(
          '[%s] The charger rejected the credentials; check the username/password in the plugin config',
          this.entry.name,
        );
      }
      if (this.consecutiveFailures === FAILURES_BEFORE_UNREACHABLE) {
        if (error instanceof VoltieApiError && error.code === 24) {
          this.platform.log.warn(
            '[%s] Charger firmware is too old for this plugin (HTTP API endpoint missing): %s',
            this.entry.name, error.message,
          );
        } else {
          this.platform.log.warn('[%s] Charger unreachable: %s', this.entry.name, error);
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
      Math.max(0, this.status.cdr?.chg_energy ?? 0),
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
      this.percentFromAmps(this.config.conf_current_limit),
    );
    this.carSensorService?.updateCharacteristic(C.ContactSensorState, this.carSensorValue());
    this.faultSensorService?.updateCharacteristic(C.ContactSensorState, this.faultSensorValue());
    this.lockService?.updateCharacteristic(C.LockCurrentState, this.lockStateValue());
    this.lockService?.updateCharacteristic(C.LockTargetState, this.lockStateValue());
    this.autostartService?.updateCharacteristic(C.On, this.config.conf_autostart_enabled === 1);
    try {
      this.syncSinglePhaseVisibility();
    } catch (error) {
      this.platform.log.error('[%s] Failed to update Single Phase switch visibility: %s', this.entry.name, error);
    }
    this.singlePhaseService?.updateCharacteristic(C.On, this.config.conf_force_single_phase === 1);

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
    const version = formatSwVersion(this.status.sw_ver);
    if (version) {
      info.updateCharacteristic(C.FirmwareRevision, version);
    }
    this.infoPopulated = true;
  }

  // ---- value mapping ----

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

  private lockStateValue(): number {
    const { LockCurrentState } = this.platform.Characteristic;
    return this.config.conf_access_mode === 1
      ? LockCurrentState.SECURED
      : LockCurrentState.UNSECURED;
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
    if (this.consecutiveFailures >= FAILURES_BEFORE_UNREACHABLE) {
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

function hsvToRgbHex(hue: number, saturation: number): string {
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
function formatSwVersion(raw: unknown): string | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const major = Math.floor(value / 1_000_000);
  const minor = Math.floor(value / 1_000) % 1_000;
  const patch = value % 1_000;
  return `${major}.${minor}.${patch}`;
}
