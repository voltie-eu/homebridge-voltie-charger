import { REQUEST_TIMEOUT_MS } from './settings';

/** EVSE states from the charger firmware (HTTP API spec appendix 5.1). */
export enum EvseState {
  Unknown = 0,
  NotConnected = 1,
  ConnectedNotCharging = 2,
  Charging = 3,
  ChargingVentilation = 4,
  // 5..17 are fault states (diode check, GFCI, no ground, stuck relay, ...).
}

export interface ChargerCdr {
  cdr_id?: number;
  chg_energy?: number; // kWh
  chg_time?: number; // s
  idle_time?: number; // s
  avg_power?: number; // kW
}

export interface ChargerStatus {
  evse_state?: number;
  is_car_connected?: boolean;
  is_charging?: boolean;
  charge_enabled?: boolean;
  charge_power?: number; // kW
  charge_current?: number; // A
  current_offered?: number; // A
  current_hw_limit?: number; // A
  mains_voltage?: number; // V
  phases_used?: number;
  charger_id?: string;
  sw_ver?: unknown;
  fw_ver?: unknown;
  first_cdr?: number;
  last_cdr?: number;
  cdr?: ChargerCdr | null; // null while no session is open
  [key: string]: unknown;
}

export interface ChargerConfig {
  conf_rear_led_enabled?: boolean;
  conf_front_led_enabled?: boolean;
  conf_disp_enabled?: boolean;
  conf_buzzer_enabled?: boolean;
  conf_out_of_service?: boolean;
  conf_dlm_mode?: number;
  conf_current_limit?: number;
  conf_autostart_enabled?: number;
  conf_access_mode?: number;
  conf_force_single_phase?: number;
  [key: string]: unknown;
}

// API error codes from the v5.x spec, section 3. 0 = OK.
const API_ERROR_MESSAGES: Record<number, string> = {
  1: 'general error (command not possible in the current state)',
  5: 'incorrect message format or parameter',
  23: 'not master: send the command to the cluster master unit instead',
  24: 'unknown command (not supported by this firmware)',
};

/** One-line, human-readable error text for user-facing logs (no stack). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class VoltieApiError extends Error {
  constructor(message: string, readonly code?: number, readonly authFailed = false) {
    super(message);
    this.name = 'VoltieApiError';
  }
}

/** True when the charger rejected the HTTP basic-auth credentials. */
export function isAuthError(error: unknown): boolean {
  return error instanceof VoltieApiError && error.authFailed;
}

// fetch() reports every network failure as "TypeError: fetch failed"; the
// useful part (ECONNREFUSED, EHOSTUNREACH, timeout) sits in error.cause.
function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  }
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === 'object') {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (typeof code === 'string') {
      return code;
    }
    if (typeof message === 'string') {
      return message;
    }
  }
  return errorText(error);
}

export class VoltieConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoltieConnectionError';
  }
}

export class VoltieClient {
  private readonly baseUrl: string;
  private readonly authHeader?: string;

  constructor(host: string, port: number, username?: string, password?: string) {
    this.baseUrl = `http://${host}:${port}`;
    if (username && password) {
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
  }

  private async request(
    method: string,
    endpoint: string,
    options: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new VoltieConnectionError(`Error talking to charger (${endpoint}): ${describeFetchError(error)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new VoltieApiError(`Authentication rejected by charger (HTTP ${response.status})`, undefined, true);
    }
    if (response.status === 404 || response.status === 405) {
      // Endpoint missing means older firmware, not a network problem (spec section 3).
      throw new VoltieApiError(`${endpoint} is not available on this firmware (HTTP ${response.status})`, 24);
    }
    if (!response.ok) {
      throw new VoltieConnectionError(`HTTP ${response.status} from ${endpoint}`);
    }

    let payload: unknown;
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new VoltieConnectionError(`Non-JSON response from ${endpoint}: ${error}`);
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new VoltieConnectionError(`Unexpected response shape from ${endpoint}`);
    }

    const record = payload as Record<string, unknown>;
    const rawCode = record['error_code'];
    // Spec 4.4: when the charger accepts a request but cannot finish it, the
    // body is just {"status": "internal timeout" | "internal error"}, with no
    // acknowledge block. Taken as success, an empty /status made every sensor
    // flip to "no car / not charging" for one poll (and back on the next),
    // and a write looked accepted while nothing was applied.
    if ((rawCode === undefined || rawCode === null) && typeof record['status'] === 'string') {
      throw new VoltieConnectionError(`Charger could not process ${method} ${endpoint}: ${record['status']}`);
    }
    if (rawCode !== undefined && rawCode !== null) {
      const code = Number(rawCode);
      if (!Number.isFinite(code)) {
        throw new VoltieConnectionError(`Non-numeric error_code from ${endpoint}: ${rawCode}`);
      }
      if (code !== 0) {
        const message = API_ERROR_MESSAGES[code] ?? `error_code=${code}`;
        throw new VoltieApiError(`Charger rejected ${method} ${endpoint}: ${message}`, code);
      }
    }
    return record;
  }

  async getStatus(): Promise<ChargerStatus> {
    return (await this.request('GET', 'status')) as ChargerStatus;
  }

  async getConfig(): Promise<ChargerConfig> {
    return (await this.request('GET', 'config')) as ChargerConfig;
  }

  async getPower(): Promise<{ dlm_valid?: boolean; [key: string]: unknown }> {
    const result = await this.request('GET', 'power');
    const stat = result['power_stat'];
    return stat && typeof stat === 'object' ? (stat as Record<string, unknown>) : {};
  }

  /** A stored charging record; null when it does not exist (spec 5.5). */
  async getCdr(cdrId: number): Promise<ChargerCdr | null> {
    const result = await this.request('GET', 'cdr', { params: { cdr_id: String(cdrId) } });
    const cdr = result['cdr'];
    return cdr && typeof cdr === 'object' ? (cdr as ChargerCdr) : null;
  }

  async setConfig(values: Record<string, unknown>): Promise<void> {
    const result = await this.request('PUT', 'config', { body: values });
    // The charger reports how many parameters it accepted; a shortfall means a
    // silent rejection (unsupported hardware, cable connected, EVSE fault).
    const accepted = result['accepted'];
    if (typeof accepted === 'number' && accepted < Object.keys(values).length) {
      throw new VoltieApiError(
        `Charger accepted only ${accepted}/${Object.keys(values).length} config parameters`,
      );
    }
  }

  private async command(command: string, params?: Record<string, unknown>): Promise<void> {
    const body: Record<string, unknown> = { command };
    if (params) {
      body['params'] = params;
    }
    await this.request('POST', 'extras', { body });
  }

  async reboot(): Promise<void> {
    await this.command('charger_reboot');
  }

  /** brightness 0..1, colorRgb "RRGGBB"; the effect expires after durationSec. */
  async setRearLed(brightness: number, colorRgb: string, durationSec: number): Promise<void> {
    await this.command('rear_led_set', {
      brightness,
      // The firmware requires the '#RRGGBB' form (spec 4.10.2).
      color_rgb: `#${colorRgb.replace(/^#/, '').toUpperCase()}`,
      duration_sec: durationSec,
    });
  }

  /** Spec 5.3: an id_tag outside this format is dropped silently, and an
   * RFID-mode charger then refuses to start. */
  static isValidIdTag(idTag: string): boolean {
    return /^[0-9A-Za-z_-]{8,}$/.test(idTag);
  }

  async start(name: string, idTag?: string): Promise<void> {
    const params: Record<string, string> = { name };
    if (idTag) {
      params['id_tag'] = idTag;
    }
    await this.request('GET', 'start', { params });
  }

  async stop(): Promise<void> {
    await this.request('GET', 'stop');
  }
}

// The firmware's own booleans are authoritative; evse_state is the fallback
// for older API versions that do not report them.
export function isCarConnected(status: ChargerStatus): boolean {
  if (typeof status.is_car_connected === 'boolean') {
    return status.is_car_connected;
  }
  const state = status.evse_state;
  return state === EvseState.ConnectedNotCharging
    || state === EvseState.Charging
    || state === EvseState.ChargingVentilation;
}

export function isCharging(status: ChargerStatus): boolean {
  if (typeof status.is_charging === 'boolean') {
    return status.is_charging;
  }
  const state = status.evse_state;
  return state === EvseState.Charging || state === EvseState.ChargingVentilation;
}

/**
 * Outlet "On" state: an accepted start command shows up immediately as
 * charge_enabled even while the car is still ramping up, so the switch does
 * not appear to bounce back between the tap and the first amps flowing.
 */
export function isSwitchedOn(status: ChargerStatus): boolean {
  return isCharging(status) || status.charge_enabled === true;
}

// Fault states per the firmware's EVSE state enum (Modbus API doc v1.1 ch. 5,
// which documents the same internal enum the HTTP API reports): 5..17 are
// EVSE/internal errors, 20 = no MID meter, 21 = HPOW board unidentified.
// 18 (charger disabled), 19 (boot), 24 (state undetermined) and
// 25 (VoltieMeter firmware upload) are NOT faults — treating everything >= 5
// as a fault made the Fault sensor fire on every charger boot.
const FAULT_STATES = new Set([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21]);

export function isFault(status: ChargerStatus): boolean {
  return typeof status.evse_state === 'number' && FAULT_STATES.has(status.evse_state);
}
