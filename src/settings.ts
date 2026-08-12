export const PLATFORM_NAME = 'VoltieCharger';
export const PLUGIN_NAME = 'homebridge-voltie-charger';

export const DEFAULT_PORT = 5059;
export const DEFAULT_POLL_INTERVAL_S = 15;
export const MIN_POLL_INTERVAL_S = 5;
export const MAX_POLL_INTERVAL_S = 300;
export const REQUEST_TIMEOUT_MS = 6000;

// conf_current_limit bounds from the HTTP API v5.x spec (appendix 5.4).
export const CURRENT_LIMIT_MIN_A = 6;
export const CURRENT_LIMIT_FALLBACK_MAX_A = 32;

// Charging session name reported to the charger on /start.
export const START_NAME = 'homebridge';

export const DISCOVERY_TIMEOUT_MS = 8000;
// Re-browse cadence so chargers added to the network later appear without a
// Homebridge restart.
export const REDISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
