// Client for Renode's ExternalControl server (`emulation CreateExternalControlServer "<name>" <port>`).
// Wire format reverse-read from Renode 1.17.0 tools/external_control_client/lib (MIT, Antmicro):
//
//   envelope : u16 id, u32 dataSize (little endian, packed, 6 bytes), then dataSize bytes
//   payload  : u16 command, u8 type, then the command body
//   ids      : client-initiated requests have bit 15 set; requests the server makes (events) do not
//   events   : type EVENT_REQUEST, body = i32 event descriptor + event data; the client answers
//              with the same message id and type SUCCESS (SPI transmit answers with the MISO byte)
//
// While a RUN_FOR is in flight the server sends events (GPIO edges, SPI bytes) and blocks the
// emulation until each one is answered, so a GPIO callback here sees the exact virtual time of the
// edge and can answer an SPI byte before the firmware reads it. That is what makes the time model
// deterministic: Renode never runs ahead of Faber.
import { Socket } from "node:net";

/** Command ids, in sync with Antmicro.Renode.Network.ExternalControl.Command. */
export const Command = {
  CheckVersion: 0,
  RunFor: 1,
  GetTime: 2,
  GetMachine: 3,
  Adc: 4,
  Gpio: 5,
  SystemBus: 6,
  TimeElapsedCallback: 7,
  Spi: 8,
  CanBus: 9,
} as const;
export type Command = (typeof Command)[keyof typeof Command];
const commandName = (c: number) => Object.keys(Command).find((k) => Command[k as keyof typeof Command] === c) ?? `#${c}`;

const MsgType = { Request: 0, EventRequest: 1, Success: 2, InvalidCommand: 3, Error: 4 } as const;
type MsgType = (typeof MsgType)[keyof typeof MsgType];

const CLIENT_INITIATED = 0x8000;
const PROTOCOL_VERSION = 0;

const GpioOp = { GetState: 0, SetState: 1, RegisterEvent: 2 } as const;
type GpioOp = (typeof GpioOp)[keyof typeof GpioOp];
const AdcOp = { GetChannelCount: 0, GetChannelValue: 1, SetChannelValue: 2 } as const;

/** A GPIO edge reported by Renode: virtual time in ns and the new level. */
export interface GpioEvent {
  timeNs: bigint;
  state: boolean;
}

type EventHandler = (data: Buffer) => Buffer | undefined;

interface Pending {
  resolve: (body: Buffer) => void;
  reject: (err: Error) => void;
  command: Command;
}

export class ExternalControlError extends Error {}

/** One TCP connection to an ExternalControl server. Requests are serialised (the server handles one at a time). */
export class ExternalControlClient {
  private readonly socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private handlers: EventHandler[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.failAll(new ExternalControlError("Renode closed the ExternalControl connection")));
    socket.on("error", (e) => this.failAll(new ExternalControlError(`ExternalControl socket error: ${e.message}`)));
  }

  /** Connect and run the CHECK_VERSION handshake. Retries until `timeoutMs` because Renode opens the port late. */
  static async connect(port: number, host = "127.0.0.1", timeoutMs = 20_000): Promise<ExternalControlClient> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const s = new Socket();
          s.once("error", reject);
          s.connect(port, host, () => {
            s.off("error", reject);
            resolve(s);
          });
        });
        const client = new ExternalControlClient(socket);
        const v = Buffer.alloc(4);
        v.writeUInt32LE(PROTOCOL_VERSION);
        await client.request(Command.CheckVersion, v);
        return client;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new ExternalControlError(
      `could not reach Renode's ExternalControl server on ${host}:${port} within ${timeoutMs} ms (${String(lastErr)}). ` +
        `Fix: start it in the monitor with 'emulation CreateExternalControlServer "faber" ${port}' and make sure the port is published.`,
    );
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  /** Machine descriptor for a `mach create "<name>"` machine. */
  async getMachine(name: string): Promise<number> {
    const body = await this.request(Command.GetMachine, str(name));
    return body.readInt32LE(0);
  }

  /** Run every machine for `ns` nanoseconds of virtual time. Resolves when Renode has paused again. */
  async runFor(ns: bigint): Promise<void> {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(ns);
    await this.request(Command.RunFor, b);
  }

  /** Current virtual time in ns. */
  async getTime(): Promise<bigint> {
    const body = await this.request(Command.GetTime, Buffer.alloc(8));
    return body.readBigUInt64LE(0);
  }

  /** Instance descriptor for a peripheral by its monitor path relative to sysbus (e.g. "gpioPortC", "spi1.extSpi"). */
  async getInstance(command: typeof Command.Gpio | typeof Command.Adc | typeof Command.Spi, machine: number, name: string): Promise<number> {
    const head = Buffer.alloc(8);
    head.writeInt32LE(-1, 0);
    head.writeInt32LE(machine, 4);
    const body = await this.request(command, Buffer.concat([head, str(name)]));
    const id = body.readInt32LE(0);
    if (id < 0) throw new ExternalControlError(`Renode has no ${commandName(command)} peripheral '${name}' on machine ${machine}`);
    return id;
  }

  async gpioGet(gpio: number, pin: number): Promise<boolean> {
    const body = await this.request(Command.Gpio, gpioHeader(gpio, GpioOp.GetState, pin));
    return body.readUInt8(0) !== 0;
  }

  /** Drive a GPIO input of the peripheral (OnGPIO): what a button or another chip would do to the pin. */
  async gpioSet(gpio: number, pin: number, state: boolean): Promise<void> {
    await this.request(Command.Gpio, Buffer.concat([gpioHeader(gpio, GpioOp.SetState, pin), Buffer.from([state ? 1 : 0])]));
  }

  /** Subscribe to the edges of a GPIO output. The callback runs with the emulation paused at the edge's virtual time. */
  async gpioOnChange(gpio: number, pin: number, cb: (e: GpioEvent) => void): Promise<void> {
    const ed = this.addHandler((data) => {
      cb({ timeNs: data.readBigUInt64LE(0), state: data.readUInt8(8) !== 0 });
      return undefined;
    });
    const edBuf = Buffer.alloc(4);
    edBuf.writeInt32LE(ed);
    await this.request(Command.Gpio, Buffer.concat([gpioHeader(gpio, GpioOp.RegisterEvent, pin), edBuf]));
  }

  async adcSet(adc: number, channel: number, value: number): Promise<void> {
    const b = Buffer.alloc(5 + 8);
    b.writeInt32LE(adc, 0);
    b.writeInt8(AdcOp.SetChannelValue, 4);
    b.writeInt32LE(channel, 5);
    b.writeUInt32LE(value >>> 0, 9);
    await this.request(Command.Adc, b);
  }

  /**
   * Become the SPI device behind an `SPI.ExternalControlSPIPeripheral`: `onByte` gets every MOSI byte
   * and returns the MISO byte; `onFinish` runs when the controller ends the transfer.
   */
  async spiAttach(spi: number, onByte: (mosi: number) => number, onFinish?: () => void): Promise<void> {
    const ed = this.addHandler((data) => {
      const kind = data.readUInt8(0);
      if (kind === 0) return Buffer.from([onByte(data.readUInt8(1)) & 0xff]);
      onFinish?.();
      return undefined;
    });
    const b = Buffer.alloc(8);
    b.writeInt32LE(spi, 0);
    b.writeInt32LE(ed, 4);
    await this.request(Command.Spi, b);
  }

  // --- transport ---

  private addHandler(h: EventHandler): number {
    this.handlers.push(h);
    return this.handlers.length - 1;
  }

  private request(command: Command, body: Buffer): Promise<Buffer> {
    const run = () =>
      new Promise<Buffer>((resolve, reject) => {
        if (this.closed) return reject(new ExternalControlError("ExternalControl connection is closed"));
        const id = CLIENT_INITIATED | (this.nextId++ & 0x7fff);
        this.pending.set(id, { resolve, reject, command });
        this.send(id, command, MsgType.Request, body);
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private send(id: number, command: number, type: MsgType, body: Buffer = Buffer.alloc(0)): void {
    const head = Buffer.alloc(9);
    head.writeUInt16LE(id, 0);
    head.writeUInt32LE(3 + body.length, 2);
    head.writeUInt16LE(command, 6);
    head.writeUInt8(type, 8);
    this.socket.write(Buffer.concat([head, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 6) {
      const size = this.buffer.readUInt32LE(2);
      if (this.buffer.length < 6 + size) return;
      const id = this.buffer.readUInt16LE(0);
      const msg = this.buffer.subarray(6, 6 + size);
      this.buffer = this.buffer.subarray(6 + size);
      this.onMessage(id, msg);
    }
  }

  private onMessage(id: number, msg: Buffer): void {
    const command = msg.readUInt16LE(0);
    const type = msg.readUInt8(2) as MsgType;
    const body = msg.subarray(3);
    if (type === MsgType.EventRequest) {
      const ed = body.readInt32LE(0);
      const h = this.handlers[ed];
      if (!h) {
        this.send(id, command, MsgType.Error, Buffer.from(`no handler for event descriptor ${ed}`));
        return;
      }
      let reply: Buffer | undefined;
      try {
        reply = h(body.subarray(4));
      } catch (e) {
        this.send(id, command, MsgType.Error, Buffer.from(String(e)));
        return;
      }
      this.send(id, command, MsgType.Success, reply);
      return;
    }
    if (type === MsgType.Request) {
      this.send(id, command, MsgType.InvalidCommand);
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (type === MsgType.Success) p.resolve(body);
    else if (type === MsgType.InvalidCommand) p.reject(new ExternalControlError(`Renode does not know command ${commandName(p.command)}`));
    else p.reject(new ExternalControlError(`Renode ${commandName(p.command)} failed: ${body.toString("utf8") || "no message"}`));
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

function str(s: string): Buffer {
  const n = Buffer.alloc(4);
  const b = Buffer.from(s, "utf8");
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
}

function gpioHeader(gpio: number, op: GpioOp, pin: number): Buffer {
  const b = Buffer.alloc(9);
  b.writeInt32LE(gpio, 0);
  b.writeInt8(op, 4);
  b.writeInt32LE(pin, 5);
  return b;
}
