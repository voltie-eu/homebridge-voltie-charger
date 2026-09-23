import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatSwVersion, hsvToRgbHex } from '../src/accessory';
import { ChargeCompleteDetector } from '../src/chargeComplete';
import { ChargerStatus } from '../src/client';

const charging: ChargerStatus = {
  is_car_connected: true, is_charging: true, charge_enabled: true, current_offered: 16,
};
const carIdle: ChargerStatus = {
  is_car_connected: true, is_charging: false, charge_enabled: true, current_offered: 16,
};

function run(sequence: ChargerStatus[]): { fired: number[]; complete: boolean } {
  const detector = new ChargeCompleteDetector();
  const fired: number[] = [];
  sequence.forEach((status, i) => {
    if (detector.update(status)) {
      fired.push(i);
    }
  });
  return { fired, complete: detector.isComplete };
}

describe('ChargeCompleteDetector', () => {
  it('fires once, on the second poll after the car stops drawing', () => {
    const result = run([charging, charging, carIdle, carIdle, carIdle, carIdle]);
    assert.deepEqual(result.fired, [3]);
    assert.equal(result.complete, true);
  });

  it('rides out a single-poll car pause', () => {
    assert.deepEqual(run([charging, carIdle, charging, carIdle, charging]).fired, []);
  });

  it('does not fire when DLM/solar pauses the session (0 A offered)', () => {
    const paused = { ...carIdle, current_offered: 0 };
    assert.deepEqual(run([charging, paused, paused, paused]).fired, []);
  });

  it('does not fire on a deliberate stop (charge_enabled cleared)', () => {
    const stopped = { ...carIdle, charge_enabled: false };
    assert.deepEqual(run([charging, stopped, stopped, stopped]).fired, []);
  });

  it('does not fire after a restart with an already full car', () => {
    assert.deepEqual(run([carIdle, carIdle, carIdle]).fired, []);
  });

  it('resets on unplug and on resumed charging', () => {
    const unplugged: ChargerStatus = { is_car_connected: false, is_charging: false, charge_enabled: false };
    assert.equal(run([charging, carIdle, carIdle, unplugged]).complete, false);
    assert.equal(run([charging, carIdle, carIdle, charging]).complete, false);
  });
});

describe('helpers', () => {
  it('decodes the packed software version', () => {
    assert.equal(formatSwVersion(1003051), '1.3.51');
    assert.equal(formatSwVersion(0), undefined);
    assert.equal(formatSwVersion('x'), undefined);
  });

  it('converts HomeKit hue/saturation to RGB hex', () => {
    assert.equal(hsvToRgbHex(0, 100), 'FF0000');
    assert.equal(hsvToRgbHex(120, 100), '00FF00');
    assert.equal(hsvToRgbHex(240, 100), '0000FF');
    assert.equal(hsvToRgbHex(30, 0), 'FFFFFF');
    assert.equal(hsvToRgbHex(360, 100), 'FF0000');
  });
});
