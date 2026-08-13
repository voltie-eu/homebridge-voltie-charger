# Changelog

## 0.1.10

- While a session is running, the current dimmer now shows the current the charger is actually offering instead of the stored configuration limit, which can sit dormant until its next write and made the dimmer misleading (e.g. 0% while charging at 16 A). Writing the dimmer still sets the configuration limit, which takes effect immediately on a running session

## 0.1.9

- The Charge Complete sensor no longer fires when DLM/eco/solar/grid modes pause the session: it now requires the charger to still be offering current (the car declining it is what "full" looks like), and the condition must hold for two polls, riding out brief car-side pauses

## 0.1.8

- A colour set from HomeKit is no longer kept alive forever: it expires after the firmware's one-hour window and the LED returns to the charger's own behaviour. The permanent refresh silently overrode the LED controls in the Voltie app, which appeared dead while HomeKit held a colour

## 0.1.7

- The Fault sensor no longer opens on non-fault charger states: booting, charger disabled, state-not-yet-determined and VoltieMeter-firmware-upload were misclassified as faults (every charger restart triggered a false fault notification). Fault states now follow the firmware's documented EVSE state list, including the previously missed "no MID meter" and "power board unidentified" states

## 0.1.6

- Tidier settings form: credentials, optional services and the manually configured chargers list live in collapsible sections, so the default view is just the name and the discovery toggle. The blank charger row is no longer visible unless you open the manual section (a saved host-less row remains harmless and ignored)

## 0.1.5

- Rear LED lamp On/Off now maps to the charger's persistent LED-enable setting with real readback; turning it off also cancels any active colour override (which used to keep glowing for up to an hour). Colour and brightness still use the temporary override, and the last set colour survives restarts
- Autostart switch writes are accepted by current firmware again (it validates the value as a JSON boolean on write while reporting 0/1 on read); an automatic fallback covers older firmware
- User-facing log lines show a one-line reason instead of a stack trace; full details remain at debug level
- Assorted state-consistency fixes around the rear LED from the pre-release review

## 0.1.4

- New: **Charge Complete** contact sensor (default on) — opens when the car finishes charging on its own while still plugged in; a deliberate stop does not trigger it. Ideal for a "car is charged" notification
- Fixed phantom lock/switch change notifications on child-bridge restart: no fabricated states are reported before the first successful poll
- A config field missing from one poll keeps its last known value instead of flipping states; the RFID lock only changes on a definite value
- Service display names now include the charger name (e.g. "Voltie 77ED RFID Lock") so push notifications identify the charger; user renames are preserved
- npm publishing via GitHub Actions on release

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
