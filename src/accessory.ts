import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  ChargerConfig,
  ChargerStatus,
  isCarConnected,
  isFault,
  isSwitchedOn,
  VoltieClient,
} from './client';
import type { ChargerConfigEntry, VoltieChargerPlatform } from './platform';
import { CURRENT_LIMIT_FALLBACK_MAX_A, CURRENT_LIMIT_MIN_A, START_NAME } from './settings';

interface ResolvedEntry extends ChargerConfigEntry {
  name: string;
  host?: string;
  port: number;
  pollInterval: number;
}

const REFRESH_AFTER_WRITE_MS = 1500;
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

  private status: ChargerStatus = {};
  private config: ChargerConfig = {};
  private consecutiveFailures = 0;
  private infoPopulated = false;

  private brightnessTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

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

    void this.poll();
    const timer = setInterval(() => void this.poll(), this.entry.pollInterval * 1000);
    this.platform.api.on('shutdown', () => {
      clearInterval(timer);
      clearTimeout(this.brightnessTimer);
      clearTimeout(this.refreshTimer);
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

  // ---- HomeKit -> charger ----

  private async setCharging(on: boolean): Promise<void> {
    try {
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
      await this.client.setConfig({ conf_autostart_enabled: enabled ? 1 : 0 });
      this.config.conf_autostart_enabled = enabled ? 1 : 0;
    } catch (error) {
      this.platform.log.error('[%s] Failed to set autostart: %s', this.entry.name, error);
      throw this.communicationError();
    } finally {
      this.scheduleRefresh();
    }
  }

  // ---- polling ----

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), REFRESH_AFTER_WRITE_MS);
  }

  private async poll(): Promise<void> {
    try {
      const [status, config] = await Promise.all([
        this.client.getStatus(),
        this.client.getConfig(),
      ]);
      this.status = status;
      this.config = config;
      if (this.consecutiveFailures >= FAILURES_BEFORE_UNREACHABLE) {
        this.platform.log.info('[%s] Charger is reachable again', this.entry.name);
      }
      this.consecutiveFailures = 0;
      this.pushState();
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === FAILURES_BEFORE_UNREACHABLE) {
        this.platform.log.warn('[%s] Charger unreachable: %s', this.entry.name, error);
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

    this.populateAccessoryInfo();
  }

  private populateAccessoryInfo(): void {
    if (this.infoPopulated) {
      return;
    }
    const { Service: S, Characteristic: C } = this.platform;
    const info = this.accessory.getService(S.AccessoryInformation)!;
    if (typeof this.status.charger_id === 'string' && this.status.charger_id) {
      info.updateCharacteristic(C.SerialNumber, this.status.charger_id);
    }
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
