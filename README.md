# homebridge-voltie-charger

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
| **Lock** ("RFID Lock", optional) | Locked = charging requires an RFID card, Unlocked = free charging. |
| **Switch** ("Autostart", optional) | The charger's autostart setting. |
| **Switch** ("Single Phase", automatic) | Forces 1-phase charging (for solar surplus). Appears only on chargers that support phase switching; `singlePhaseSwitch: "show"`/`"hide"` overrides. |
| **Switch** ("Reboot", optional) | Momentary switch that reboots the charger. |
| **Lightbulb** ("Rear LED", optional) | The charger's rear LED strip as a color lamp (effect expires after an hour, a firmware limit). |

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

`username`/`password` are only needed when the charger's HTTP API has authentication enabled. `idTag` lets the start command carry an RFID id when the charger is in RFID mode.

## Notes and limitations

- Discovery uses mDNS multicast, which does not cross subnets/VLANs; chargers on another subnet must be configured by address. In Docker the container must run in host network mode (HomeKit itself requires this too).
- The plugin polls the charger (default every 15 s); state changes made elsewhere (app, RFID card, cable) appear within one poll cycle.
- The current-limit dimmer writes the charger's persistent configuration; the debounced slider makes sure only the final value is written.
- Beware of "turn off all the lights" style scenes if you enable the dimmer: the bulb's off switch stops charging. Disable `currentControl` if that bothers you.

## Development

```bash
npm install
npm run build
```
