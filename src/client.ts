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
  chg_energy?: number; // kWh
  chg_time?: number; // s
  idle_time?: number; // s
  avg_power?: number; // kW
}

export interface ChargerStatus {
  evse_state?: number;
  charge_power?: number; // kW
  charge_current?: number; // A
  current_offered?: number; // A
  current_hw_limit?: number; // A
  mains_voltage?: number; // V
  phases_used?: number;
  charger_id?: string;
  sw_ver?: unknown;
  fw_ver?: unknown;
  cdr?: ChargerCdr;
  [key: string]: unknown;
}

export interface ChargerConfig {
  conf_current_limit?: number;
  conf_autostart_enabled?: number;
  conf_access_mode?: number;
  [key: string]: unknown;
}

// API error codes from the v5.x spec, section 3. 0 = OK.
const API_ERROR_MESSAGES: Record<number, string> = {
  1: 'general error (command not possible in the current state)',
  5: 'incorrect message format or parameter',
  23: 'not master: send the command to the cluster master unit instead',
  24: 'unknown command (not supported by this firmware)',
};

export class VoltieApiError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'VoltieApiError';
  }
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
      throw new VoltieConnectionError(`Error talking to charger (${endpoint}): ${error}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new VoltieApiError(`Authentication rejected by charger (HTTP ${response.status})`);
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

export function isCarConnected(state: number | undefined): boolean {
  return state === EvseState.ConnectedNotCharging
    || state === EvseState.Charging
    || state === EvseState.ChargingVentilation;
}

export function isCharging(state: number | undefined): boolean {
  return state === EvseState.Charging || state === EvseState.ChargingVentilation;
}

export function isFault(state: number | undefined): boolean {
  return typeof state === 'number' && state >= 5;
}
