# homebridge-voltie-charger

Homebridge plugin for [Voltie](https://voltie.eu) EV chargers. Talks to the charger directly on your local network through its built-in HTTP API (v5.x, default port 5059) — no cloud connection required.

> Already running Home Assistant? Consider the official [Voltie Home Assistant integration](https://github.com/voltie-eu/homeassistant-voltie_charger) together with HA's built-in HomeKit Bridge instead — it exposes far more entities. This plugin is for households that use Apple Home without Home Assistant.

## What appears in the Home app

HomeKit has no native EV charger category, so the charger is mapped onto standard accessories (the same approach used by other charger plugins):

| Service | Function |
|---|---|
| **Outlet** | On = charging is active; switching it starts/stops charging. "In Use" = car connected. |
| **Lightbulb dimmer** ("Current") | Charging current limit: 0% = 6 A, 100% = the charger's hardware maximum. On/off also starts/stops charging. Siri: *"Set the charger current to 50%"* |
| **Contact sensor** ("Car Connected") | Opens when a car is plugged in — use it to trigger automations. |
| **Contact sensor** ("Fault") | Opens when the EVSE reports a fault state (GFCI, no ground, overtemperature, ...). |
| **Lock** ("RFID Lock", optional) | Locked = charging requires an RFID card, Unlocked = free charging. |
| **Switch** ("Autostart", optional) | The charger's autostart setting. |

Live power (W), total session energy (kWh), voltage and current are attached to the Outlet as Eve characteristics — visible in Eve, Controller or Home+ (the native Home app ignores them).

## Requirements

- The charger's **HTTP API enabled** (Voltie app → charger settings), reachable from the Homebridge host.
- Homebridge ≥ 1.8, Node.js ≥ 18.

## Configuration

Via the Homebridge UI, or manually:

```json
{
  "platform": "VoltieCharger",
  "chargers": [
    {
      "name": "Garage Charger",
      "host": "192.168.1.201",
      "port": 5059,
      "pollInterval": 15,
      "currentControl": true,
      "carConnectedSensor": true,
      "faultSensor": true,
      "accessLock": false,
      "autostartSwitch": false
    }
  ]
}
```

`username`/`password` are only needed when the charger's HTTP API has authentication enabled. `idTag` lets the start command carry an RFID id when the charger is in RFID mode.

## Notes and limitations

- The plugin polls the charger (default every 15 s); state changes made elsewhere (app, RFID card, cable) appear within one poll cycle.
- The current-limit dimmer writes the charger's persistent configuration; the debounced slider makes sure only the final value is written.
- Beware of "turn off all the lights" style scenes if you enable the dimmer: the bulb's off switch stops charging. Disable `currentControl` if that bothers you.

## Development

```bash
npm install
npm run build
```
