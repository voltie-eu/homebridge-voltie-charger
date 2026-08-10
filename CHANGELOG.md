# Changelog

## 0.1.3

- Feature toggles (current dimmer, sensors, RFID lock, autostart, single-phase, reboot, rear LED) and pollInterval/idTag can now be set at the platform level too, acting as defaults for every charger, including discovered ones; per-charger entries still override

## 0.1.2

- A charger entry without a host (the blank row the config UI saves when the list is left untouched) is no longer logged as an error; with discovery on it is reported as a normal info line

## 0.1.1

Verification-readiness fixes, no functional changes.

- config.schema.json: strict JSON Schema `required` array instead of inline boolean, top-level `name` property
- package.json: `supports-hap` keyword, explicit `homepage`, tidied homebridge engines range

## 0.1.0

Initial release.

- Outlet (charging on/off, car-connected "in use", Eve power/energy/voltage/current)
- Charging current limit as a dimmer (6 A .. hardware max)
- Car-connected and fault contact sensors
- Optional RFID access lock, autostart switch, reboot switch
- Rear LED strip as a color lamp (with keep-alive past the firmware's 1 h effect expiry)
- Single Phase switch with automatic visibility on phase-switching chargers
- Zero-config mDNS discovery with HTTP API probing and periodic re-browse
- "Identify" flashes the rear LED
