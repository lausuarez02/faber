// Faber bridge for Renode (MIT, like Renode): one socket between a Renode machine and Faber that
// carries every signal the circuit can see as a time-stamped text line, in emulation order.
//
// Compiled into Renode at start (`include @/faber/platforms/FaberBridge.cs`) and placed on the
// bus as `faber: Miscellaneous.FaberBridge @ sysbus 0x5FFF0000` (a 4-byte dummy register so the
// monitor can reach it as `sysbus.faber`). `sysbus.faber Connect "<host>" <port>` dials Faber.
//
//   Faber -> Renode                         Renode -> Faber
//   R <ns>        run for ns, then T         H faber-renode-bridge <version>
//   I <gpio> <pin> <0|1>  drive an input     T <ns>             parked (virtual ns)
//   X <uart> <hex>        bytes into RX      G <id> <0|1> <o|i> <ns>  watched pin: level, direction
//   A <adc> <ch> <mv>     analog input       U <id> <ns> <hex>  UART TX bytes
//   W <gpio> <pin> <id>   watch an output    IW <addr> <ns> <hex>  I2C write (no answer)
//   S <uart> <id>         watch a UART TX    IR <addr> <n> <ns>    I2C read: answer D <hex>
//   D <hex>               I2C read answer    IP <addr> <ns>        I2C stop
//   K <0|1>               address ACK        IC <addr> <r|w> <ns>  I2C START + address (controller models): answer K
//   M <hex>               SPI MISO answer    SX <bus> <hex> <ns>   SPI byte: answer M <hex>
//   Z                     machine reset      SW <bus> <hex> <ns>   SPI byte, MISO not needed
//   Q                     quit Renode        SE <bus> <ns>         SPI transfer end
//                                            P <key> <periodNs> <highNs> <ns>  PWM output (models without pins)
//                                            E <text>              error
//
// Virtual time is the machine's local time source. Outputs never wait for Faber; only an I2C read
// and an SPI byte whose MISO matters block the emulation until Faber answers, which keeps it fast.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure.Registers;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Analog;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.I2C;
using Antmicro.Renode.Peripherals.SPI;
using Antmicro.Renode.Peripherals.UART;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class FaberBridge : IDoubleWordPeripheral, IKnownSize
    {
        public const int Version = 1;
        public static FaberBridge Instance { get; private set; }

        public FaberBridge(IMachine machine)
        {
            this.machine = machine;
            Instance = this;
        }

        public long Size => 4;
        public uint ReadDoubleWord(long offset) => 0;
        public void WriteDoubleWord(long offset, uint value) { }
        public void Reset() { }

        /// <summary>Dial Faber and start serving commands (returns at once).</summary>
        public void Connect(string host, int port)
        {
            client = new TcpClient();
            client.NoDelay = true;
            client.Connect(host, port);
            var stream = client.GetStream();
            writer = new StreamWriter(stream, new UTF8Encoding(false), 1 << 16) { NewLine = "\n", AutoFlush = false };
            reader = new StreamReader(stream, Encoding.ASCII);
            Send($"H faber-renode-bridge {Version}", flush: true);
            var t = new Thread(ReadLoop) { IsBackground = true, Name = "faber-bridge" };
            t.Start();
        }

        /// <summary>
        /// Put the app's initial stack pointer and reset vector (at `app`) at address 0, as a board's
        /// bootloader does: the CPU then reaches the app from 0 at power-on and after every reset
        /// (NVIC_SystemReset), with VectorTableOffset 0.
        /// </summary>
        public void BootVector(long app)
        {
            var bytes = machine.SystemBus.ReadBytes((ulong)app, 8);
            machine.SystemBus.WriteBytes(bytes, 0);
        }

        /// <summary>
        /// Every peripheral interrupt line wakes a WFE, like a pending interrupt does on the chip with
        /// SEVONPEND even while the interrupt is masked (Nordic's SoftDevice masks the app's interrupts
        /// in its critical regions; FreeRTOS's tickless idle then waits in WFE for the RTC). Renode 1.17
        /// does not wake WFE for a masked interrupt. Returns how many lines it watches.
        /// </summary>
        public int WakeWfeOnInterrupts()
        {
            var cpu = machine.SystemBus.GetCPUs().FirstOrDefault();
            var setEvent = cpu?.GetType().GetMethod("SetEventFlag", Type.EmptyTypes);
            if(setEvent == null) return 0;
            var n = 0;
            foreach(var per in machine.GetPeripheralsOfType<IPeripheral>())
            {
                foreach(var prop in per.GetType().GetProperties())
                {
                    if(prop.PropertyType != typeof(GPIO) || !(prop.Name == "IRQ" || prop.Name.EndsWith("Interrupt"))) continue;
                    if(!(prop.GetValue(per) is GPIO line)) continue;
                    line.AddStateChangedHook(v => { if(v) setEvent.Invoke(cpu, null); });
                    n++;
                }
            }
            return n;
        }

        /// <summary>Fill memory with one byte value (erased flash reads 0xFF; Renode's memory starts at 0).</summary>
        public void Fill(long start, long size, int value)
        {
            var chunk = new byte[0x10000];
            for(var i = 0; i < chunk.Length; i++) chunk[i] = (byte)value;
            for(long off = 0; off < size; off += chunk.Length)
            {
                var n = (int)Math.Min(chunk.Length, size - off);
                machine.SystemBus.WriteBytes(n == chunk.Length ? chunk : chunk.Take(n).ToArray(), (ulong)(start + off));
            }
        }

        /// <summary>
        /// Virtual time in ns, to the instruction. Renode's time source only moves at sync points (every
        /// quantum, 100 us by default), so the time inside a quantum comes from the instructions the CPU
        /// has executed (each one is 1000 / MIPS ns); time that passed without instructions (WFI with
        /// advance-immediately) is added when the time source shows it.
        /// </summary>
        public ulong Now
        {
            get
            {
                lock(timeLock)
                {
                    var local = (double)machine.LocalTimeSource.ElapsedVirtualTime.TotalNanoseconds;
                    if(cpu == null)
                    {
                        cpu = machine.SystemBus.GetCPUs().FirstOrDefault();
                        instrProp = cpu?.GetType().GetProperty("ExecutedInstructions");
                        mipsProp = cpu?.GetType().GetProperty("PerformanceInMips");
                    }
                    if(instrProp == null || mipsProp == null) return (ulong)local;
                    var mips = System.Convert.ToDouble(mipsProp.GetValue(cpu));
                    var byInstr = System.Convert.ToDouble(instrProp.GetValue(cpu)) * 1000.0 / mips + idleNs;
                    if(local > byInstr)
                    {
                        idleNs += local - byInstr;
                        byInstr = local;
                    }
                    var ns = (ulong)byInstr;
                    if(ns < lastNs) ns = lastNs;
                    lastNs = ns;
                    return ns;
                }
            }
        }

        private readonly object timeLock = new object();
        private Antmicro.Renode.Peripherals.CPU.ICPU cpu;
        private System.Reflection.PropertyInfo instrProp, mipsProp;
        private double idleNs;
        private ulong lastNs;

        public void Send(string line, bool flush = false)
        {
            lock(writeLock)
            {
                if(writer == null) return;
                writer.Write(line);
                writer.Write('\n');
                if(flush) writer.Flush();
            }
        }

        /// <summary>Send a request and block (the emulation thread) until Faber answers with a line starting with `answer`.</summary>
        public string Ask(string line, char answer)
        {
            Send(line, flush: true);
            if(answers.TryTake(out var a, AnswerTimeoutMs))
            {
                if(a.Length > 0 && a[0] == answer) return a.Length > 2 ? a.Substring(2) : "";
                this.Log(LogLevel.Warning, "faber bridge: expected '{0}' answer, got '{1}'", answer, a);
                return "";
            }
            this.Log(LogLevel.Error, "faber bridge: no answer to '{0}' within {1} ms", line, AnswerTimeoutMs);
            return "";
        }

        public int AnswerTimeoutMs { get; set; } = 30000;

        /// <summary>Set by Faber at start: some SPI device can drive MISO, so controller models ask for each byte.</summary>
        public bool SpiNeedsMiso { get; set; } = true;

        /// <summary>Analog input in millivolts set by Faber, for ADC models that read it (key "adc:channel").</summary>
        public int AnalogMv(string adc, int channel)
        {
            return analog.TryGetValue(adc + ":" + channel, out var mv) ? mv : 0;
        }

        private void ReadLoop()
        {
            try
            {
                string line;
                while((line = reader.ReadLine()) != null)
                {
                    if(line.Length == 0) continue;
                    try
                    {
                        Handle(line);
                    }
                    catch(Exception e)
                    {
                        Send("E " + line.Split(' ')[0] + ": " + e.Message.Replace('\n', ' '), flush: true);
                    }
                }
            }
            catch(Exception)
            {
                // socket closed: Faber went away
            }
            Environment.Exit(0);
        }

        private void Handle(string line)
        {
            var p = line.Split(' ');
            switch(p[0])
            {
            case "R":
            {
                var ns = ulong.Parse(p[1], CultureInfo.InvariantCulture);
                ReapplyInputs();
                // Run on its own thread so this loop keeps reading answers (D / M) while the CPU waits for them.
                var t = new Thread(() =>
                {
                    try
                    {
                        EmulationManager.Instance.CurrentEmulation.RunFor(TimeInterval.FromNanoseconds(ns));
                        Send($"T {Now}", flush: true);
                    }
                    catch(Exception e)
                    {
                        Send("E R: " + e.Message.Replace('\n', ' '), flush: true);
                    }
                }) { IsBackground = true, Name = "faber-run" };
                t.Start();
                break;
            }
            case "D":
            case "M":
            case "K":
                answers.Add(line);
                break;
            case "I":
            {
                var rx = Peripheral(p[1]) as IGPIOReceiver;
                if(rx == null) throw new ArgumentException($"no GPIO receiver '{p[1]}'");
                var level = p[3] == "1";
                inputs[p[1] + ":" + p[2]] = level;
                rx.OnGPIO(int.Parse(p[2]), level);
                break;
            }
            case "X":
            {
                var uart = Peripheral(p[1]) as IUART;
                if(uart == null) throw new ArgumentException($"no UART '{p[1]}'");
                foreach(var b in Hex(p.Length > 2 ? p[2] : "")) uart.WriteChar(b);
                break;
            }
            case "A":
            {
                var mv = int.Parse(p[3]);
                analog[p[1] + ":" + p[2]] = mv;
                var adc = Peripheral(p[1]);
                if(adc is STM32_ADC st)
                {
                    // Renode's STM32 ADC returns the fed value as the conversion result (12-bit, 3.3 V reference).
                    var code = (uint)Math.Max(0, Math.Min(4095, Math.Round(mv * 4095.0 / VrefMv)));
                    st.FeedSample(code, uint.Parse(p[2]), -1);
                }
                break;
            }
            case "W":
            {
                var per = Peripheral(p[1]);
                var src = per as INumberedGPIOOutput;
                if(src == null) throw new ArgumentException($"no GPIO output peripheral '{p[1]}'");
                var pin = int.Parse(p[2]);
                if(!src.Connections.TryGetValue(pin, out var g) || !(g is GPIO gpio)) throw new ArgumentException($"'{p[1]}' has no output {pin}");
                var watch = PortOf(p[1], per);
                var id = p[3];
                watch.Pins[pin] = new WatchedPin { Id = id, Gpio = gpio };
                gpio.AddStateChangedHook(v => Send($"G {id} {(v ? 1 : 0)} {(watch.IsOutput(pin) ? 'o' : 'i')} {Now}"));
                if(gpio.IsSet || watch.IsOutput(pin)) Send($"G {id} {(gpio.IsSet ? 1 : 0)} {(watch.IsOutput(pin) ? 'o' : 'i')} {Now}");
                break;
            }
            case "S":
            {
                var uart = Peripheral(p[1]) as IUART;
                if(uart == null) throw new ArgumentException($"no UART '{p[1]}'");
                var id = p[2];
                uart.CharReceived += b => Send($"U {id} {Now} {b:X2}");
                break;
            }
            case "Z":
                machine.Reset();
                Send($"T {Now}", flush: true);
                break;
            case "Q":
                Send("T 0", flush: true);
                Environment.Exit(0);
                break;
            default:
                throw new ArgumentException($"unknown command '{p[0]}'");
            }
        }

        private class WatchedPin
        {
            public string Id;
            public GPIO Gpio;
        }

        /// <summary>Knows each pin's direction from the port's configuration writes, so Faber sees pinMode() even when the level does not change, and can tell an output from an input that echoes the level it drives.</summary>
        private class PortWatch
        {
            public string Kind;
            public ulong Base;
            public ulong OutputMask; // bit n: pin n is an output (or alternate function)
            public readonly Dictionary<ulong, uint> Last = new Dictionary<ulong, uint>(); // last value written per register
            public readonly Dictionary<int, WatchedPin> Pins = new Dictionary<int, WatchedPin>();
            public bool IsOutput(int pin) => Kind == "unknown" || ((OutputMask >> pin) & 1) == 1;
        }

        private PortWatch PortOf(string name, IPeripheral per)
        {
            if(ports.TryGetValue(name, out var w)) return w;
            w = new PortWatch();
            var type = per.GetType().Name;
            w.Kind = type == "STM32F1GPIOPort" ? "f1" : type == "STM32_GPIOPort" ? "moder" : type == "NRF52840_GPIO" ? "nrf" : "unknown";
            ports[name] = w;
            if(w.Kind == "unknown") return w;
            var bus = machine.GetSystemBus((IBusPeripheral)per);
            w.Base = bus.GetRegistrationPoints((IBusPeripheral)per).First().Range.StartAddress;
            // Reset state: STM32 F1 every pin floating input; F4 MODER from the register (debug pins are AF); nRF all inputs.
            if(w.Kind == "f1")
            {
                Apply(w, 0x0, bus.ReadDoubleWord(w.Base + 0x0));
                Apply(w, 0x4, bus.ReadDoubleWord(w.Base + 0x4));
            }
            else if(w.Kind == "moder") Apply(w, 0x0, bus.ReadDoubleWord(w.Base));
            // Direction registers, plus the ones that set a pull-up / pull-down (F1: ODR, BSRR, BRR; F4: PUPDR).
            var offsets = w.Kind == "f1" ? new ulong[] { 0x0, 0x4, 0xC, 0x10, 0x14 } : w.Kind == "moder" ? new ulong[] { 0x0, 0xC } : new ulong[] { 0x14, 0x18, 0x1C }.Concat(Enumerable.Range(0, 32).Select(i => 0x200UL + 4UL * (ulong)i)).ToArray();
            foreach(var off in offsets)
            {
                var o = off;
                bus.AddWatchpointHook(w.Base + o, SysbusAccessWidth.DoubleWord, Access.Write, (cpu, addr, width, value) =>
                {
                    var before = w.OutputMask;
                    // Pins whose own configuration this write touches: the inputs Faber drives are applied
                    // again at the next step, so they win over the port's pull state and every model on the
                    // way (STM32 AFIO / EXTI) has seen their level.
                    var touched = Touched(w, o, (uint)value);
                    if(touched != 0) lock(dirty) dirty[name] = (dirty.TryGetValue(name, out var d) ? d : 0) | touched;
                    Apply(w, o, (uint)value);
                    var changed = before ^ w.OutputMask;
                    if(changed == 0) return;
                    foreach(var kv in w.Pins)
                    {
                        if(((changed >> kv.Key) & 1) == 0) continue;
                        Send($"G {kv.Value.Id} {(kv.Value.Gpio.IsSet ? 1 : 0)} {(w.IsOutput(kv.Key) ? 'o' : 'i')} {Now}");
                    }
                });
            }
            return w;
        }

        private static void Apply(PortWatch w, ulong off, uint v)
        {
            switch(w.Kind)
            {
            case "f1":
            {
                if(off > 0x4) break;
                var first = off == 0 ? 0 : 8;
                for(var i = 0; i < 8; i++)
                {
                    var mode = (v >> (4 * i)) & 0x3; // MODE[1:0] != 0: output (push-pull, open-drain or AF)
                    Set(w, first + i, mode != 0);
                }
                break;
            }
            case "moder":
                if(off != 0x0) break;
                for(var i = 0; i < 16; i++)
                {
                    var m = (v >> (2 * i)) & 0x3; // 01 output, 10 alternate function
                    Set(w, i, m == 1 || m == 2);
                }
                break;
            case "nrf":
                if(off == 0x14) w.OutputMask = v;
                else if(off == 0x18) w.OutputMask |= v;
                else if(off == 0x1C) w.OutputMask &= ~(ulong)v;
                else Set(w, (int)((off - 0x200) / 4), (v & 1) == 1);
                break;
            }
        }

        private static void Set(PortWatch w, int pin, bool output)
        {
            if(output) w.OutputMask |= 1UL << pin;
            else w.OutputMask &= ~(1UL << pin);
        }

        private readonly Dictionary<string, PortWatch> ports = new Dictionary<string, PortWatch>();
        /// <summary>The level Faber drives on each input ("gpio:pin").</summary>
        private readonly ConcurrentDictionary<string, bool> inputs = new ConcurrentDictionary<string, bool>();
        /// <summary>Pins (a mask per port) the firmware reconfigured since the last step.</summary>
        private readonly Dictionary<string, ulong> dirty = new Dictionary<string, ulong>();

        /// <summary>Which pins a configuration write touches (fields that changed, or bits set / cleared).</summary>
        private static ulong Touched(PortWatch w, ulong off, uint v)
        {
            ulong mask = 0;
            var old = w.Last.TryGetValue(off, out var x) ? x : 0u;
            w.Last[off] = v;
            if(w.Kind == "f1" && off <= 0x4)
            {
                for(var i = 0; i < 8; i++) if((((old ^ v) >> (4 * i)) & 0xF) != 0) mask |= 1UL << (i + (off == 0 ? 0 : 8));
            }
            else if(w.Kind == "f1") mask = off == 0x10 ? (v & 0xFFFF) | (v >> 16) : off == 0x14 ? v & 0xFFFF : (old ^ v) & 0xFFFF;
            else if(w.Kind == "moder")
            {
                for(var i = 0; i < 16; i++) if((((old ^ v) >> (2 * i)) & 0x3) != 0) mask |= 1UL << i;
            }
            else if(w.Kind == "nrf") mask = off >= 0x200 ? 1UL << (int)((off - 0x200) / 4) : off == 0x14 ? old ^ v : v;
            return mask;
        }

        /// <summary>
        /// Before a step: the inputs Faber drives on pins the firmware just reconfigured are applied
        /// again, so the port and the models behind it (STM32 AFIO / EXTI) hold Faber's level.
        /// </summary>
        private void ReapplyInputs()
        {
            KeyValuePair<string, ulong>[] items;
            lock(dirty)
            {
                if(dirty.Count == 0) return;
                items = dirty.ToArray();
                dirty.Clear();
            }
            foreach(var item in items)
            {
                var w = ports[item.Key];
                var rx = Peripheral(item.Key) as IGPIOReceiver;
                foreach(var kv in w.Pins)
                {
                    if(((item.Value >> kv.Key) & 1) == 0 || w.IsOutput(kv.Key) || !inputs.TryGetValue(item.Key + ":" + kv.Key, out var lvl)) continue;
                    // STM32F1: the port and AFIO only pass a change on, and a pull-up write leaves them out of
                    // step with the pin, so the first falling edge would be lost: go through the other level.
                    if(w.Kind == "f1" || w.Kind == "nrf") rx?.OnGPIO(kv.Key, !lvl);
                    rx?.OnGPIO(kv.Key, lvl);
                }
            }
        }

        public int VrefMv { get; set; } = 3300;

        private IPeripheral Peripheral(string name)
        {
            if(!cache.TryGetValue(name, out var per))
            {
                if(!machine.TryGetByName("sysbus." + name, out per)) throw new ArgumentException($"no peripheral 'sysbus.{name}'");
                cache[name] = per;
            }
            return per;
        }

        public static byte[] Hex(string s)
        {
            var b = new byte[s.Length / 2];
            for(var i = 0; i < b.Length; i++) b[i] = byte.Parse(s.Substring(2 * i, 2), NumberStyles.HexNumber);
            return b;
        }

        public static string Hex(IEnumerable<byte> data)
        {
            var sb = new StringBuilder();
            foreach(var x in data) sb.Append(x.ToString("X2"));
            return sb.ToString();
        }

        private readonly IMachine machine;
        private readonly object writeLock = new object();
        private readonly BlockingCollection<string> answers = new BlockingCollection<string>();
        private readonly ConcurrentDictionary<string, int> analog = new ConcurrentDictionary<string, int>();
        private readonly Dictionary<string, IPeripheral> cache = new Dictionary<string, IPeripheral>();
        private TcpClient client;
        private StreamWriter writer;
        private StreamReader reader;
    }

    /// <summary>An I2C target at one address whose bytes go to Faber's I2C bus (the part models answer).</summary>
    public class FaberI2cTarget : II2CPeripheral
    {
        public FaberI2cTarget(int address)
        {
            this.address = address;
        }

        public void Write(byte[] data)
        {
            var b = FaberBridge.Instance;
            b?.Send($"IW {address:X2} {b.Now} {FaberBridge.Hex(data)}");
        }

        public byte[] Read(int count = 1)
        {
            var b = FaberBridge.Instance;
            if(b == null) return Enumerable.Repeat((byte)0xFF, count).ToArray();
            var hex = b.Ask($"IR {address:X2} {count} {b.Now}", 'D');
            var r = FaberBridge.Hex(hex);
            if(r.Length < count) r = r.Concat(Enumerable.Repeat((byte)0xFF, count - r.Length)).ToArray();
            return r;
        }

        public void FinishTransmission()
        {
            var b = FaberBridge.Instance;
            b?.Send($"IP {address:X2} {b.Now}");
        }

        public void Reset() { }

        private readonly int address;
    }

    /// <summary>The device side of an SPI controller, forwarded to Faber's SPI bus. With Sync false the MISO byte is not asked for (write-only devices such as displays) and reads 0xFF.</summary>
    public class FaberSpiTarget : ISPIPeripheral
    {
        public FaberSpiTarget(string bus = "spi0", bool sync = true)
        {
            this.bus = bus;
            Sync = sync;
        }

        public bool Sync { get; set; }

        public byte Transmit(byte data)
        {
            var b = FaberBridge.Instance;
            if(b == null) return 0xFF;
            if(!Sync)
            {
                b.Send($"SW {bus} {data:X2} {b.Now}");
                return 0xFF;
            }
            var hex = b.Ask($"SX {bus} {data:X2} {b.Now}", 'M');
            return hex.Length >= 2 ? byte.Parse(hex.Substring(0, 2), NumberStyles.HexNumber) : (byte)0xFF;
        }

        public void FinishTransmission()
        {
            var b = FaberBridge.Instance;
            b?.Send($"SE {bus} {b.Now}");
        }

        public void Reset() { }

        private readonly string bus;
    }

    /// <summary>Cortex-M DWT with a CYCCNT that counts executed instructions (CPI 1, the core clock is the CPU's MIPS). STM32duino and Mbed busy-wait on it; Renode has no DWT model.</summary>
    public class FaberDwt : IDoubleWordPeripheral, IKnownSize
    {
        public FaberDwt(IMachine machine)
        {
            this.machine = machine;
        }

        public long Size => 0x1000;

        public void Reset()
        {
            ctrl = 0;
            offset = 0;
        }

        public uint ReadDoubleWord(long off)
        {
            if(off == 0x0) return ctrl | (4u << 28); // NUMCOMP = 4
            if(off == 0x4) return (uint)(Instructions() - offset);
            if(off == 0xFB4) return 0; // LSR: no lock
            return 0;
        }

        public void WriteDoubleWord(long off, uint value)
        {
            if(off == 0x0) ctrl = value;
            else if(off == 0x4) offset = Instructions() - value;
        }

        private ulong Instructions()
        {
            if(cpu == null)
            {
                cpu = machine.SystemBus.GetCPUs().FirstOrDefault();
                prop = cpu?.GetType().GetProperty("ExecutedInstructions");
            }
            return prop == null ? 0 : System.Convert.ToUInt64(prop.GetValue(cpu));
        }

        private readonly IMachine machine;
        private Antmicro.Renode.Peripherals.CPU.ICPU cpu;
        private System.Reflection.PropertyInfo prop;
        private uint ctrl;
        private ulong offset;
    }
}
