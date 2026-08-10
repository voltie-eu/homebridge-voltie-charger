import type { API, Characteristic, WithUUID } from 'homebridge';

/**
 * Eve history/energy characteristics. Not part of HAP, so the native Home app
 * ignores them, but Eve, Controller and Home+ show live power/energy readings
 * on the outlet service.
 */
export interface EveCharacteristics {
  CurrentConsumption: WithUUID<new () => Characteristic>; // W
  TotalConsumption: WithUUID<new () => Characteristic>; // kWh
  Voltage: WithUUID<new () => Characteristic>; // V
  ElectricCurrent: WithUUID<new () => Characteristic>; // A
}

export function buildEveCharacteristics(api: API): EveCharacteristics {
  const { Characteristic: Char, Formats, Perms } = api.hap;

  class CurrentConsumption extends Char {
    static readonly UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Current Consumption', CurrentConsumption.UUID, {
        format: Formats.FLOAT,
        unit: 'W',
        minValue: 0,
        maxValue: 100000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class TotalConsumption extends Char {
    static readonly UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Total Consumption', TotalConsumption.UUID, {
        format: Formats.FLOAT,
        unit: 'kWh',
        minValue: 0,
        maxValue: 1000000,
        minStep: 0.001,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class Voltage extends Char {
    static readonly UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Voltage', Voltage.UUID, {
        format: Formats.FLOAT,
        unit: 'V',
        minValue: 0,
        maxValue: 1000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class ElectricCurrent extends Char {
    static readonly UUID = 'E863F126-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Electric Current', ElectricCurrent.UUID, {
        format: Formats.FLOAT,
        unit: 'A',
        minValue: 0,
        maxValue: 1000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  return { CurrentConsumption, TotalConsumption, Voltage, ElectricCurrent };
}
