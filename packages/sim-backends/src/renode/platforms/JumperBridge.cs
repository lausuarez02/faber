// Jumper bridge for Renode (MIT, like Renode): one socket between a Renode machine and Jumper that
// carries every signal the circuit can see as a time-stamped text line, in emulation order.
//
// Compiled into Renode at start (`include @/jumper/platforms/JumperBridge.cs`) and placed on the
// bus as `jumper: Miscellaneous.JumperBridge @ sysbus 0x5FFF0000` (a 4-byte dummy register so the
// monitor can reach it as `sysbus.jumper`). `sysbus.jumper Connect "<host>" <port>` dials Jumper.
//
//   Jumper -> Renode                         Renode -> Jumper
//   R <ns>        run for ns, then T         H jumper-renode-bridge <version>
//   I <gpio> <pin> <0|1>  drive an input     T <ns>             parked (virtual ns)
//   X <uart> <hex>        bytes into RX      G <id> <0|1> <o|i> <ns>  watched pin: level, direction
//   A <adc> <ch> <mv>     analog input       U <id> <ns> <hex>  UART TX bytes
//   W <gpio> <pin> <id>   watch an output    IW <addr> <ns> <hex>  I2C write (no answer)
//   S <uart> <id>         watch a UART TX    IR <addr> <n> <ns>    I2C read: answer D <hex>
//   D <hex>               I2C read answer    IP <addr> <ns>        I2C stop
//   M <hex>               SPI MISO answer    SX <bus> <hex> <ns>   SPI byte: answer M <hex>
//   Z                     machine reset      SW <bus> <hex> <ns>   SPI byte, MISO not needed
//   Q                     quit Renode        SE <bus> <ns>         SPI transfer end
//                                            P <key> <periodNs> <highNs> <ns>  PWM output (models without pins)
//                                            E <text>              error
//
// Virtual time is the machine's local time source. Outputs never wait for Jumper; only an I2C read
// and an SPI byte whose MISO matters block the emulation until Jumper answers, which keeps it fast.
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
    public class JumperBridge : IDoubleWordPeripheral, IKnownSize
    {
        public const int Version = 1;
        public static JumperBridge Instance { get; private set; }

        public JumperBridge(IMachine machine)
        {
            this.machine = machine;
            Instance = this;
        }

        public long Size => 4;
        public uint ReadDoubleWord(long offset) => 0;
        public void WriteDoubleWord(long offset, uint value) { }
        public void Reset() { }

        /// <summary>Dial Jumper and start serving commands (returns at once).</summary>
        public void Connect(string host, int port)
        {
            client = new TcpClient();
            client.NoDelay = true;
            client.Connect(host, port);
            var stream = client.GetStream();
            writer = new StreamWriter(stream, new UTF8Encoding(false), 1 << 16) { NewLine = "\n", AutoFlush = false };
            reader = new StreamReader(stream, Encoding.ASCII);
            Send($"H jumper-renode-bridge {Version}", flush: true);
            var t = new Thread(ReadLoop) { IsBackground = true, Name = "jumper-bridge" };
            t.Start();
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

        /// <summary>Send a request and block (the emulation thread) until Jumper answers with a line starting with `answer`.</summary>
        public string Ask(string line, char answer)
        {
            Send(line, flush: true);
            if(answers.TryTake(out var a, AnswerTimeoutMs))
            {
                if(a.Length > 0 && a[0] == answer) return a.Length > 2 ? a.Substring(2) : "";
                this.Log(LogLevel.Warning, "jumper bridge: expected '{0}' answer, got '{1}'", answer, a);
                return "";
            }
            this.Log(LogLevel.Error, "jumper bridge: no answer to '{0}' within {1} ms", line, AnswerTimeoutMs);
            return "";
        }

        public int AnswerTimeoutMs { get; set; } = 30000;

        /// <summary>Analog input in millivolts set by Jumper, for ADC models that read it (key "adc:channel").</summary>
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
                // socket closed: Jumper went away
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
                }) { IsBackground = true, Name = "jumper-run" };
                t.Start();
                break;
            }
            case "D":
            case "M":
                answers.Add(line);
                break;
            case "I":
            {
                var rx = Peripheral(p[1]) as IGPIOReceiver;
                if(rx == null) throw new ArgumentException($"no GPIO receiver '{p[1]}'");
                rx.OnGPIO(int.Parse(p[2]), p[3] == "1");
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

        /// <summary>Knows each pin's direction from the port's configuration writes, so Jumper sees pinMode() even when the level does not change, and can tell an output from an input that echoes the level it drives.</summary>
        private class PortWatch
        {
            public string Kind;
            public ulong Base;
            public ulong OutputMask; // bit n: pin n is an output (or alternate function)
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
            var offsets = w.Kind == "f1" ? new ulong[] { 0x0, 0x4 } : w.Kind == "moder" ? new ulong[] { 0x0 } : new ulong[] { 0x14, 0x18, 0x1C }.Concat(Enumerable.Range(0, 32).Select(i => 0x200UL + 4UL * (ulong)i)).ToArray();
            foreach(var off in offsets)
            {
                var o = off;
                bus.AddWatchpointHook(w.Base + o, SysbusAccessWidth.DoubleWord, Access.Write, (cpu, addr, width, value) =>
                {
                    var before = w.OutputMask;
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
                var first = off == 0 ? 0 : 8;
                for(var i = 0; i < 8; i++)
                {
                    var mode = (v >> (4 * i)) & 0x3; // MODE[1:0] != 0: output (push-pull, open-drain or AF)
                    Set(w, first + i, mode != 0);
                }
                break;
            }
            case "moder":
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

    /// <summary>An I2C target at one address whose bytes go to Jumper's I2C bus (the part models answer).</summary>
    public class JumperI2cTarget : II2CPeripheral
    {
        public JumperI2cTarget(int address)
        {
            this.address = address;
        }

        public void Write(byte[] data)
        {
            var b = JumperBridge.Instance;
            b?.Send($"IW {address:X2} {b.Now} {JumperBridge.Hex(data)}");
        }

        public byte[] Read(int count = 1)
        {
            var b = JumperBridge.Instance;
            if(b == null) return Enumerable.Repeat((byte)0xFF, count).ToArray();
            var hex = b.Ask($"IR {address:X2} {count} {b.Now}", 'D');
            var r = JumperBridge.Hex(hex);
            if(r.Length < count) r = r.Concat(Enumerable.Repeat((byte)0xFF, count - r.Length)).ToArray();
            return r;
        }

        public void FinishTransmission()
        {
            var b = JumperBridge.Instance;
            b?.Send($"IP {address:X2} {b.Now}");
        }

        public void Reset() { }

        private readonly int address;
    }

    /// <summary>The device side of an SPI controller, forwarded to Jumper's SPI bus. With Sync false the MISO byte is not asked for (write-only devices such as displays) and reads 0xFF.</summary>
    public class JumperSpiTarget : ISPIPeripheral
    {
        public JumperSpiTarget(string bus = "spi0", bool sync = true)
        {
            this.bus = bus;
            Sync = sync;
        }

        public bool Sync { get; set; }

        public byte Transmit(byte data)
        {
            var b = JumperBridge.Instance;
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
            var b = JumperBridge.Instance;
            b?.Send($"SE {bus} {b.Now}");
        }

        public void Reset() { }

        private readonly string bus;
    }

    /// <summary>Cortex-M DWT with a CYCCNT that counts executed instructions (CPI 1, the core clock is the CPU's MIPS). STM32duino and Mbed busy-wait on it; Renode has no DWT model.</summary>
    public class JumperDwt : IDoubleWordPeripheral, IKnownSize
    {
        public JumperDwt(IMachine machine)
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
