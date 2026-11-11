// A logical I2S bus: digital audio between an MCU's I2S peripheral and part models (an amplifier
// such as the MAX98357A that plays what the firmware sends, a microphone such as the INMP441 that
// the firmware records from). Generic sample frames with virtual time; nothing here knows what
// the audio is for. Electrical behaviour (BCLK/WS edges) is not simulated: the backend reports
// whole blocks of frames at the virtual time the peripheral's DMA moved them.
//
// Deterministic: no wall clock; cycles come from the backend.

import type { Unsubscribe } from "./mcu.ts";

export interface I2sFormat {
  /** Frames per second (one frame = one sample per channel). */
  sampleRate: number;
  /** Bits per sample slot as the firmware configured them (16, 24 or 32). */
  bits: number;
  /** 1 (mono) or 2 (stereo, left first). */
  channels: number;
}

/** Frames the MCU sent, interleaved per channel, signed, scaled to `bits` (a 16-bit sample is -32768..32767). */
export interface I2sBlock extends I2sFormat {
  /** MCU cycle at which the first frame left the peripheral. */
  cycle: number;
  samples: Int32Array;
}

/** What the MCU asks a source for: `frames` frames in `format`, starting at `cycle`. */
export interface I2sRequest extends I2sFormat {
  cycle: number;
  frames: number;
}

/**
 * What an I2S part model implements. A sink (amplifier, DAC) implements i2sReceive; a source
 * (microphone, ADC) implements i2sProvide. A part may do both (a codec).
 */
export interface I2sDevice {
  i2sReceive?(block: I2sBlock): void;
  /** Interleaved samples (frames × channels), scaled to req.bits. undefined = the part drives nothing (silence). */
  i2sProvide?(req: I2sRequest): Int32Array | undefined;
}

export interface I2sStats {
  framesOut: number;
  framesIn: number;
  blocksOut: number;
  blocksIn: number;
  /** Format of the last block in each direction. */
  outFormat?: I2sFormat;
  inFormat?: I2sFormat;
}

interface I2sAttached {
  partId: string;
  device: I2sDevice;
}

/** One I2S bus (port). Every sink hears what the MCU sends; the first source that answers feeds the MCU. */
export class I2sBus {
  readonly id: string;
  private devices: I2sAttached[] = [];
  private _stats: I2sStats = { framesOut: 0, framesIn: 0, blocksOut: 0, blocksIn: 0 };
  private listeners = new Set<(block: I2sBlock) => void>();

  constructor(id = "i2s0") {
    this.id = id;
  }

  attach(partId: string, device: I2sDevice): Unsubscribe {
    const entry = { partId, device };
    this.devices.push(entry);
    return () => {
      this.devices = this.devices.filter((d) => d !== entry);
    };
  }

  list(): { partId: string; sink: boolean; source: boolean }[] {
    return this.devices.map((d) => ({ partId: d.partId, sink: !!d.device.i2sReceive, source: !!d.device.i2sProvide }));
  }

  get stats(): Readonly<I2sStats> {
    return this._stats;
  }

  /** Listen to every block the MCU sends (tests, the audio monitor). */
  onBlock(cb: (block: I2sBlock) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  // ------------------------------------------------------------------ MCU side

  /** The MCU sent `block`. */
  send(block: I2sBlock): void {
    const frames = Math.floor(block.samples.length / Math.max(1, block.channels));
    this._stats.framesOut += frames;
    this._stats.blocksOut++;
    this._stats.outFormat = { sampleRate: block.sampleRate, bits: block.bits, channels: block.channels };
    for (const d of this.devices) d.device.i2sReceive?.(block);
    for (const l of this.listeners) l(block);
  }

  /** The MCU wants `req.frames` frames. Silence (zeros) when no source answers. */
  request(req: I2sRequest): Int32Array {
    this._stats.framesIn += req.frames;
    this._stats.blocksIn++;
    this._stats.inFormat = { sampleRate: req.sampleRate, bits: req.bits, channels: req.channels };
    const n = req.frames * Math.max(1, req.channels);
    for (const d of this.devices) {
      const s = d.device.i2sProvide?.(req);
      if (!s) continue;
      if (s.length === n) return s;
      const out = new Int32Array(n);
      out.set(s.subarray(0, n));
      return out;
    }
    return new Int32Array(n);
  }

  reset(): void {
    this.devices = [];
    this._stats = { framesOut: 0, framesIn: 0, blocksOut: 0, blocksIn: 0 };
  }
}
