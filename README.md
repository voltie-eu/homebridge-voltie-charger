# homebridge-voltie-charger

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://img.shields.io/npm/v/homebridge-voltie-charger?style=for-the-badge)](https://www.npmjs.com/package/homebridge-voltie-charger)

Homebridge plugin for [Voltie](https://voltie.eu) EV chargers. Talks to the charger directly on your local network through its built-in HTTP API (v5.x, default port 5059), with no cloud connection required. Chargers on the local network are **discovered automatically** at startup via mDNS/Bonjour, so in the common case there is nothing to configure. (Restart Homebridge to pick up a charger added to the network later.)

> Already running Home Assistant? Consider the official [Voltie Home Assistant integration](https://github.com/voltie-eu/homeassistant-voltie_charger) together with HA's built-in HomeKit Bridge instead, as it exposes far more entities. This plugin is for households that use Apple Home without Home Assistant.

## What appears in the Home app

HomeKit has no native EV charger category, so the charger is mapped onto standard accessories (the same approach used by other charger plugins):

| Service | Function |
|---|---|
| **Outlet** | On = charging is active or enabled (waiting for the car); switching it starts/stops charging. "In Use" = car connected. |
| **Lightbulb dimmer** ("Current") | Charging current limit: 0% = 6 A, 100% = the charger's hardware maximum (up to 32 A). On/off also starts/stops charging. Siri: *"Set the charger current to 50%"* |
| **Contact sensor** ("Car Connected") | Opens when a car is plugged in: use it to trigger automations. |
| **Contact sensor** ("Fault") | Opens when the EVSE reports a fault state (GFCI, no ground, overtemperature, ...). |
| **Contact sensor** ("Charge Complete") | Opens when the car finishes charging on its own while still plugged in; a deliberate stop does not trigger it. Ideal for a "car is charged" notification. |
| **Lock** ("RFID Lock", optional) | Locked = charging requires an RFID card, Unlocked = free charging. |
| **Switch** ("Autostart", optional) | The charger's autostart setting. |
| **Switch** ("Single Phase", automatic) | Forces 1-phase charging (for solar surplus). Appears only on chargers that support phase switching; `singlePhaseSwitch: "show"`/`"hide"` overrides. |
| **Switch** ("Reboot", optional) | Momentary switch that reboots the charger. |
| **Lightbulb** ("Rear LED", optional) | The charger's rear LED strip as a color lamp. On/off is the persistent LED setting; a colour is a temporary one-hour effect. |

Live power (W), total session energy (kWh), voltage and current are attached to the Outlet as Eve characteristics: visible in Eve, Controller or Home+ (the native Home app ignores them).

## Requirements

- The charger's **HTTP API enabled** (Voltie app → charger settings), reachable from the Homebridge host.
- Homebridge ≥ 1.8, Node.js ≥ 18.

## Configuration

With automatic discovery (the default) an empty platform block is enough:

```json
{ "platform": "VoltieCharger" }
```

Chargers can also be configured explicitly via the Homebridge UI, or manually; explicit entries always win over discovery for the same device:

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

`username`/`password` are only needed when the charger's HTTP API has authentication enabled; set them at the platform level to cover every charger (including discovered ones), or per charger entry to override. `idTag` lets the start command carry an RFID id when the charger is in RFID mode.

## Automation ideas

- **"Car is charged" notification**: automate on the *Charge Complete* contact sensor opening. It only fires when the car stops drawing on its own while still plugged in — a manual stop does not trigger it.
- **Plug-in reminder or actions**: automate on the *Car Connected* sensor opening (e.g. turn on the garage light, start charging if autostart is off).
- **Solar surplus charging**: on phase-switching chargers, flip the *Single Phase* switch from a scene or schedule to limit charging to one phase while your inverter covers it.
- **Fault alert**: automate a notification on the *Fault* sensor opening.
- Siri understands the services by name: *"Set the charger current to 50%"*, *"Turn on the charger"*, *"Set the charger rear LED to blue"*.

## Notes and limitations

- Discovery uses mDNS multicast, which does not cross subnets/VLANs; chargers on another subnet must be configured by address. In Docker the container must run in host network mode (HomeKit itself requires this too).
- The plugin polls the charger (default every 15 s); state changes made elsewhere (app, RFID card, cable) appear within one poll cycle.
- The current-limit dimmer writes the charger's persistent configuration; the debounced slider makes sure only the final value is written.
- Beware of "turn off all the lights" style scenes if you enable the dimmer: the bulb's off switch stops charging. Disable `currentControl` if that bothers you.

## Firmware compatibility

The plugin adapts to what the charger reports:

- The Single Phase switch only appears on chargers that report phase-switching support.
- The rear LED lamp's on/off maps to the charger's persistent LED setting on current firmware, with a transparent fallback on older firmware.
- Config fields missing from a firmware are simply not written; commands the firmware rejects as unknown log a "firmware too old" hint.

## Troubleshooting 🛠️

**Charger not discovered.** Confirm the HTTP API is enabled in the Voltie app. If your network blocks mDNS (VLANs, some Docker setups without host networking), add the charger manually by IP.

**Authentication fails.** The credentials are the ones set inside the charger's HTTP API config, not your Voltie cloud account.

**Accessory shows "No Response".** The plugin retries automatically; if it persists, check the charger's power and Wi-Fi signal. The log shows a one-line reason (`homebridge -D` adds full detail).

**"Firmware too old" in the log.** The plugin needs the v5 HTTP API. Update the charger from the Voltie app.

## Development

```bash
npm install
npm run build
```

## License

MIT. Copyright © 2026 Voltie Kft. See [LICENSE](LICENSE).
