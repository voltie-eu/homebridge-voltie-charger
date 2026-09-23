import { mkdirSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname } from 'path';
import { format } from 'util';

import type { API, Characteristic, Logging, PlatformAccessory, Service, WithUUID } from 'homebridge';

/*
 * Eve app power history ("energy" type), ported from fakegato-history
 * (MIT License, Copyright (c) 2017 simont77,
 * https://github.com/simont77/fakegato-history).
 *
 * Only the energy history with file storage is kept. The original package
 * also pulls in googleapis for an optional Google Drive storage, which on its
 * own is a ~210 MB install; that is too heavy to put on every Homebridge
 * (often a Raspberry Pi) for a feature most users leave off. The wire format
 * and the ring-buffer bookkeeping below follow the original line by line, as
 * the Eve app is strict about them.
 */

const EPOCH_OFFSET = 978307200; // 2001-01-01, Eve's epoch
const TYPE_116 = '04 0102 0202 0702 0f03';
const TYPE_117 = '1f';
const MEMORY_SIZE = 4032; // entries: 28 days at 10 minutes
export const HISTORY_INTERVAL_MS = 10 * 60 * 1000;

const EVE_UUID = (short: string) => `E863F${short}-079E-48FF-8F27-9C2605A29F52`;
const SERVICE_UUID = EVE_UUID('007');

interface Entry {
  time: number;
  power?: number;
  setRefTime?: 1;
}

type Slot = Entry | 'noValue';

interface Persisted {
  firstEntry: number;
  lastEntry: number;
  usedMemory: number;
  refTime: number;
  initialTime?: number;
  history: Slot[];
  lastPower?: number;
}

const hexToBase64 = (val: string): string => Buffer.from(val.replace(/[^0-9A-F]/ig, ''), 'hex').toString('base64');
const base64ToHex = (val: string): string => Buffer.from(val, 'base64').toString('hex');
const swap16 = (val: number): number => ((val & 0xFF) << 8) | ((val >>> 8) & 0xFF);
const swap32 = (val: number): number => ((val & 0xFF) << 24)
  | ((val & 0xFF00) << 8)
  | ((val >>> 8) & 0xFF00)
  | ((val >>> 24) & 0xFF);
function numToHex(val: number, len?: number): string {
  let s = Number(val >>> 0).toString(16);
  if (s.length % 2 !== 0) {
    s = '0' + s;
  }
  return len ? ('0000000000000' + s).slice(-1 * len) : s;
}
const round2 = (value: number): number => Math.round(value * 100) / 100;

interface HistoryChars {
  S2R1: WithUUID<new () => Characteristic>;
  S2R2: WithUUID<new () => Characteristic>;
  S2W1: WithUUID<new () => Characteristic>;
  S2W2: WithUUID<new () => Characteristic>;
  Service: WithUUID<typeof Service>;
}

let chars: HistoryChars | undefined;

function historyChars(api: API): HistoryChars {
  if (chars) {
    return chars;
  }
  const { Characteristic: Char, Service: Svc, Formats, Perms } = api.hap;
  const make = (name: string, short: string, perms: string[]) => {
    const uuid = EVE_UUID(short);
    return class extends Char {
      static readonly UUID = uuid;
      constructor() {
        super(name, uuid, { format: Formats.DATA, perms: perms as never });
      }
    };
  };
  const read = [Perms.PAIRED_READ, Perms.NOTIFY, Perms.HIDDEN];
  const write = [Perms.PAIRED_WRITE, Perms.HIDDEN];
  const S2R1 = make('S2R1', '116', read);
  const S2R2 = make('S2R2', '117', read);
  const S2W1 = make('S2W1', '11C', write);
  const S2W2 = make('S2W2', '121', write);
  class HistoryService extends Svc {
    static readonly UUID = SERVICE_UUID;
    constructor(displayName?: string, subtype?: string) {
      super(displayName, SERVICE_UUID, subtype);
      this.addCharacteristic(S2R1);
      this.addCharacteristic(S2R2);
      this.addCharacteristic(S2W1);
      this.addCharacteristic(S2W2);
    }
  }
  chars = { S2R1, S2R2, S2W1, S2W2, Service: HistoryService as unknown as WithUUID<typeof Service> };
  return chars;
}

/** Removes the history service from an accessory (feature switched off). */
export function removeEveHistory(accessory: PlatformAccessory): void {
  const existing = accessory.services.find((service) => service.UUID === SERVICE_UUID);
  if (existing) {
    accessory.removeService(existing);
  }
}

export class EveEnergyHistory {
  private readonly service: Service;
  private readonly chars: HistoryChars;

  private firstEntry = 0;
  private lastEntry = 0;
  private history: Slot[] = ['noValue'];
  private usedMemory = 0;
  private currentEntry = 1;
  private transfer = false;
  private setTime = true;
  private restarted = true;
  private refTime = 0;
  private memoryAddress = 0;
  private initialTime?: number;

  private samples: number[] = [];
  private lastPower?: number;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    api: API,
    accessory: PlatformAccessory,
    private readonly file: string,
    private readonly log: Logging,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.chars = historyChars(api);
    this.service = accessory.services.find((service) => service.UUID === SERVICE_UUID)
      ?? accessory.addService(this.chars.Service, `${accessory.displayName} History`, 'energy');
    this.service.getCharacteristic(this.chars.S2R2).onGet(() => this.readS2R2());
    this.service.getCharacteristic(this.chars.S2W1).onSet((value) => this.writeS2W1(String(value)));
    this.service.getCharacteristic(this.chars.S2W2).onSet(() => undefined);
    this.load();
  }

  /** Feed one power reading [W]; entries are 10-minute averages. */
  addSample(powerW: number): void {
    this.samples.push(powerW);
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), HISTORY_INTERVAL_MS);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One timer tick: average the samples, or repeat the last value if none
   * arrived (the charger was unreachable), so the Eve graph has no holes. */
  flush(): void {
    let power: number | undefined;
    if (this.samples.length) {
      power = round2(this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length);
    } else {
      power = this.lastPower;
    }
    this.samples = [];
    if (power === undefined) {
      return;
    }
    this.lastPower = power;
    this.addEntry({ time: Math.round(this.now() / 1000), power });
  }

  private addEntry(entry: Entry): void {
    const toAddress = (val: number) => val % MEMORY_SIZE;
    if (this.usedMemory < MEMORY_SIZE) {
      this.usedMemory++;
      this.firstEntry = 0;
      this.lastEntry = this.usedMemory;
    } else {
      this.firstEntry++;
      this.lastEntry = this.firstEntry + this.usedMemory;
      if (this.restarted) {
        this.history[toAddress(this.lastEntry)] = { time: entry.time, setRefTime: 1 };
        this.firstEntry++;
        this.lastEntry = this.firstEntry + this.usedMemory;
        this.restarted = false;
      }
    }

    if (this.refTime === 0) {
      this.refTime = entry.time - EPOCH_OFFSET;
      this.history[this.lastEntry] = { time: entry.time, setRefTime: 1 };
      this.initialTime = entry.time;
      this.lastEntry++;
      this.usedMemory++;
    }

    this.history[toAddress(this.lastEntry)] = entry;

    const full = this.usedMemory >= MEMORY_SIZE;
    const value = format(
      '%s00000000%s%s%s%s%s000000000101',
      numToHex(swap32(entry.time - this.refTime - EPOCH_OFFSET), 8),
      numToHex(swap32(this.refTime), 8),
      TYPE_116,
      numToHex(swap16(full ? this.usedMemory : this.usedMemory + 1), 4),
      numToHex(swap16(MEMORY_SIZE), 4),
      numToHex(swap32(full ? this.firstEntry + 1 : this.firstEntry), 8),
    );
    this.service.getCharacteristic(this.chars.S2R1).updateValue(hexToBase64(value));
    this.save();
  }

  /** The Eve app pulls the history in chunks of up to 11 entries. */
  readS2R2(): string {
    const toAddress = (val: number) => val % MEMORY_SIZE;
    if (!(this.currentEntry <= this.lastEntry && this.transfer)) {
      this.transfer = false;
      return hexToBase64('00');
    }
    let stream = '';
    this.memoryAddress = toAddress(this.currentEntry);
    for (let i = 0; i < 11; i++) {
      const slot = this.history[this.memoryAddress] as Entry;
      if (slot.setRefTime === 1 || this.setTime || this.currentEntry === this.firstEntry + 1) {
        stream += format(
          ',15%s 0100 0000 81%s0000 0000 00 0000',
          numToHex(swap32(this.currentEntry), 8),
          numToHex(swap32(this.refTime), 8),
        );
        this.setTime = false;
      } else {
        stream += format(
          ',14 %s%s-%s:0000 0000 %s 0000 0000',
          numToHex(swap32(this.currentEntry), 8),
          numToHex(swap32(slot.time - this.refTime - EPOCH_OFFSET), 8),
          TYPE_117,
          numToHex(swap16((slot.power ?? 0) * 10), 4),
        );
      }
      this.currentEntry++;
      this.memoryAddress = toAddress(this.currentEntry);
      if (this.currentEntry > this.lastEntry) {
        break;
      }
    }
    return hexToBase64(stream);
  }

  /** The Eve app asks for the history starting at an address. */
  writeS2W1(value: string): void {
    const hex = base64ToHex(value);
    const address = swap32(parseInt(hex.substring(4, 12), 16));
    this.currentEntry = address !== 0 ? address : 1;
    this.transfer = true;
  }

  private load(): void {
    let data: Persisted;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
    } catch {
      return; // first run, or an unreadable file: start a fresh history
    }
    if (!Array.isArray(data.history) || typeof data.lastEntry !== 'number') {
      return;
    }
    this.firstEntry = data.firstEntry;
    this.lastEntry = data.lastEntry;
    this.usedMemory = data.usedMemory;
    this.refTime = data.refTime;
    this.initialTime = data.initialTime;
    this.history = data.history;
    this.lastPower = data.lastPower;
  }

  private save(): void {
    const data: Persisted = {
      firstEntry: this.firstEntry,
      lastEntry: this.lastEntry,
      usedMemory: this.usedMemory,
      refTime: this.refTime,
      initialTime: this.initialTime,
      history: this.history,
      lastPower: this.lastPower,
    };
    const json = JSON.stringify(data);
    // Serialized, so a slow disk can't let an older snapshot win.
    this.writing = this.writing
      .then(() => {
        mkdirSync(dirname(this.file), { recursive: true });
        return writeFile(this.file, json);
      })
      .catch((error) => this.log.debug('Eve history save failed (%s): %s', this.file, error));
  }
}
