// nRF52840 peripherals Renode 1.17 does not model, for Faber (MIT, like Renode):
//   FaberNrf52Saadc  SAADC (analogRead): single-ended channels, EasyDMA results, gain / reference /
//                     resolution as configured; the input is the voltage Faber set on the AIN pin.
//   FaberNrf52Uicr   the UICR flash page: erased (0xFFFFFFFF) until written, and like flash it keeps
//                     what was written across a reset (Mbed and the SoftDevice write REGOUT0 / NFCPINS
//                     and reset once).
//   FaberNrf52Twim   TWIM0 (EasyDMA I2C master, the Adafruit core's Wire): each transfer goes to
//                     Faber's I2C bus, with the address ACK / NACK the part models give (ERRORSRC.ANACK).
//   FaberNrf52Spim   SPIM (EasyDMA SPI master; SPIM3 is the Adafruit core's SPI): each byte goes to
//                     Faber's SPI bus; MISO is asked for only when a wired device can drive it.
//   FaberNrf52Pwm    PWM0..3 (analogWrite, Servo, tone): reads the first value of the sequence from
//                     RAM and tells Faber each connected pin's period and high time ("P" line); Faber
//                     draws the edges. Events (SEQSTARTED / SEQEND / STOPPED / LOOPSDONE) fire at once.
// Not modelled: differential inputs, oversampling, the analog limits, burst and continuous sampling
// (SAADC); per-step sequence playback, NEXTSTEP, PWM waveform mode's per-period TOP (PWM).
using System;
using System.Linq;
using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class FaberNrf52Uicr : IDoubleWordPeripheral, IKnownSize
    {
        public FaberNrf52Uicr(IMachine machine) { }
        public long Size => 0x1000;
        public void Reset() { } // flash: survives a reset
        public uint ReadDoubleWord(long offset) => regs.TryGetValue(offset, out var v) ? v : 0xFFFFFFFF;
        public void WriteDoubleWord(long offset, uint value) => regs[offset] = (regs.TryGetValue(offset, out var v) ? v : 0xFFFFFFFF) & value; // flash writes only clear bits
        private readonly System.Collections.Generic.Dictionary<long, uint> regs = new System.Collections.Generic.Dictionary<long, uint>();
    }

    public class FaberNrf52Twim : IDoubleWordPeripheral, IKnownSize
    {
        public FaberNrf52Twim(IMachine machine)
        {
            this.machine = machine;
            IRQ = new GPIO();
            Reset();
        }

        public GPIO IRQ { get; }
        public long Size => 0x1000;

        public void Reset()
        {
            regs = new uint[0x1000 / 4];
            IRQ.Unset();
        }

        public uint ReadDoubleWord(long offset) => offset >= 0 && offset < 0x1000 ? regs[offset / 4] : 0;

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset < 0 || offset >= 0x1000) return;
            switch(offset)
            {
            case 0x000: if(value != 0) StartRx(); return; // STARTRX
            case 0x008: if(value != 0) StartTx(); return; // STARTTX
            case 0x014: if(value != 0) Stop(); return; // STOP
            case 0x01C: if(value != 0) Event(0x148); return; // SUSPEND -> SUSPENDED
            case 0x020: return; // RESUME
            case 0x304: regs[0x300 / 4] |= value; Update(); return;
            case 0x308: regs[0x300 / 4] &= ~value; Update(); return;
            case 0x4C4: regs[offset / 4] &= ~value; return; // ERRORSRC: write 1 to clear
            default:
                regs[offset / 4] = value;
                if(offset >= 0x100 && offset < 0x200) Update();
                return;
            }
        }

        private int Address => (int)(regs[0x588 / 4] & 0x7F);

        private bool Connect(bool read)
        {
            var b = FaberBridge.Instance;
            if(b == null) return false;
            return b.Ask($"IC {Address:X2} {(read ? 'r' : 'w')} {b.Now}", 'K') == "1";
        }

        private void StartTx()
        {
            Event(0x150); // TXSTARTED
            var b = FaberBridge.Instance;
            if(!Connect(false))
            {
                regs[0x4C4 / 4] |= 2; // ANACK
                regs[0x54C / 4] = 0;
                Event(0x124); // ERROR
                Stop();
                return;
            }
            var n = (int)(regs[0x548 / 4] & 0xFFFF);
            var data = n > 0 ? machine.SystemBus.ReadBytes(regs[0x544 / 4], n) : new byte[0];
            if(n > 0) b?.Send($"IW {Address:X2} {b.Now} {FaberBridge.Hex(data)}");
            regs[0x54C / 4] = (uint)n;
            Event(0x160); // LASTTX
            var shorts = regs[0x200 / 4];
            if((shorts & (1u << 7)) != 0) StartRx(); // LASTTX_STARTRX: repeated start
            else if((shorts & (1u << 8)) != 0) Event(0x148); // LASTTX_SUSPEND
            else if((shorts & (1u << 9)) != 0) Stop(); // LASTTX_STOP
        }

        private void StartRx()
        {
            Event(0x14C); // RXSTARTED
            var b = FaberBridge.Instance;
            if(!Connect(true))
            {
                regs[0x4C4 / 4] |= 2;
                regs[0x53C / 4] = 0;
                Event(0x124);
                Stop();
                return;
            }
            var n = (int)(regs[0x538 / 4] & 0xFFFF);
            if(n > 0 && b != null)
            {
                var data = FaberBridge.Hex(b.Ask($"IR {Address:X2} {n} {b.Now}", 'D'));
                machine.SystemBus.WriteBytes(data.Take(n).ToArray(), regs[0x534 / 4]);
            }
            regs[0x53C / 4] = (uint)n;
            Event(0x15C); // LASTRX
            if((regs[0x200 / 4] & (1u << 12)) != 0) Stop(); // LASTRX_STOP
        }

        private void Stop()
        {
            var b = FaberBridge.Instance;
            b?.Send($"IP {Address:X2} {b.Now}");
            Event(0x104); // STOPPED
        }

        private void Event(long offset)
        {
            regs[offset / 4] = 1;
            Update();
        }

        private void Update()
        {
            // INTEN bits: STOPPED 1, ERROR 9, SUSPENDED 18, RXSTARTED 19, TXSTARTED 20, LASTRX 23, LASTTX 24.
            var inten = regs[0x300 / 4];
            var pending = false;
            foreach(var (bit, off) in new[] { (1, 0x104), (9, 0x124), (18, 0x148), (19, 0x14C), (20, 0x150), (23, 0x15C), (24, 0x160) })
            {
                if(((inten >> bit) & 1) != 0 && regs[off / 4] != 0) pending = true;
            }
            IRQ.Set(pending);
        }

        private readonly IMachine machine;
        private uint[] regs;
    }

    public class FaberNrf52Spim : IDoubleWordPeripheral, IKnownSize
    {
        public FaberNrf52Spim(IMachine machine, string bus = "spim3")
        {
            this.machine = machine;
            this.bus = bus;
            IRQ = new GPIO();
            Reset();
        }

        public GPIO IRQ { get; }
        public long Size => 0x1000;

        public void Reset()
        {
            regs = new uint[0x1000 / 4];
            IRQ.Unset();
        }

        public uint ReadDoubleWord(long offset) => offset >= 0 && offset < 0x1000 ? regs[offset / 4] : 0;

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset < 0 || offset >= 0x1000) return;
            switch(offset)
            {
            case 0x010: if(value != 0) Start(); return; // START
            case 0x014: if(value != 0) Event(0x104); return; // STOP -> STOPPED
            case 0x01C: case 0x020: return; // SUSPEND / RESUME
            case 0x304: regs[0x300 / 4] |= value; Update(); return;
            case 0x308: regs[0x300 / 4] &= ~value; Update(); return;
            default:
                regs[offset / 4] = value;
                if(offset >= 0x100 && offset < 0x200) Update();
                return;
            }
        }

        private void Start()
        {
            Event(0x14C); // STARTED
            var b = FaberBridge.Instance;
            var txn = (int)(regs[0x548 / 4] & 0xFFFF);
            var rxn = (int)(regs[0x538 / 4] & 0xFFFF);
            var n = Math.Max(txn, rxn);
            var tx = txn > 0 ? machine.SystemBus.ReadBytes(regs[0x544 / 4], txn) : new byte[0];
            var rx = new byte[rxn];
            var orc = (byte)regs[0x5C0 / 4];
            for(var i = 0; i < n; i++)
            {
                var mosi = i < txn ? tx[i] : orc;
                byte miso = 0xFF;
                if(b != null)
                {
                    if(b.SpiNeedsMiso)
                    {
                        var hex = b.Ask($"SX {bus} {mosi:X2} {b.Now}", 'M');
                        if(hex.Length >= 2) miso = byte.Parse(hex.Substring(0, 2), System.Globalization.NumberStyles.HexNumber);
                    }
                    else b.Send($"SW {bus} {mosi:X2} {b.Now}");
                }
                if(i < rxn) rx[i] = miso;
            }
            if(rxn > 0) machine.SystemBus.WriteBytes(rx, regs[0x534 / 4]);
            regs[0x54C / 4] = (uint)txn;
            regs[0x53C / 4] = (uint)rxn;
            b?.Send($"SE {bus} {b?.Now}");
            Event(0x120); // ENDTX
            Event(0x110); // ENDRX
            Event(0x118); // END
        }

        private void Event(long offset)
        {
            regs[offset / 4] = 1;
            Update();
        }

        private void Update()
        {
            // INTEN bits: STOPPED 1, ENDRX 4, END 6, ENDTX 8, STARTED 19.
            var inten = regs[0x300 / 4];
            var pending = false;
            foreach(var (bit, off) in new[] { (1, 0x104), (4, 0x110), (6, 0x118), (8, 0x120), (19, 0x14C) })
            {
                if(((inten >> bit) & 1) != 0 && regs[off / 4] != 0) pending = true;
            }
            IRQ.Set(pending);
        }

        private readonly IMachine machine;
        private readonly string bus;
        private uint[] regs;
    }

    public class FaberNrf52Saadc : IDoubleWordPeripheral, IKnownSize
    {
        public FaberNrf52Saadc(IMachine machine, string name = "saadc")
        {
            this.machine = machine;
            this.name = name;
            IRQ = new GPIO();
            Reset();
        }

        public GPIO IRQ { get; }
        public long Size => 0x1000;

        public void Reset()
        {
            regs = new uint[0x1000 / 4];
            amount = 0;
            IRQ.Unset();
        }

        public uint ReadDoubleWord(long offset)
        {
            if(offset == 0x634) return (uint)amount;
            if(offset == 0x400) return 0; // STATUS: ready
            return offset >= 0 && offset < 0x1000 ? regs[offset / 4] : 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset < 0 || offset >= 0x1000) return;
            switch(offset)
            {
            case 0x000: // START
                if(value != 0) { amount = 0; Event(0x100); }
                return;
            case 0x004: // SAMPLE
                if(value != 0) Sample();
                return;
            case 0x008: // STOP
                if(value != 0) Event(0x114);
                return;
            case 0x00C: // CALIBRATEOFFSET
                if(value != 0) Event(0x110);
                return;
            case 0x304: regs[0x300 / 4] |= value; Update(); return;
            case 0x308: regs[0x300 / 4] &= ~value; Update(); return;
            default:
                regs[offset / 4] = value;
                if(offset >= 0x100 && offset < 0x180) Update();
                return;
            }
        }

        private void Sample()
        {
            var resBits = new[] { 8, 10, 12, 14 }[regs[0x5F0 / 4] & 3];
            var ptr = (ulong)regs[0x62C / 4];
            var max = (int)(regs[0x630 / 4] & 0x7FFF);
            for(var ch = 0; ch < 8; ch++)
            {
                var pselp = regs[(0x510 + ch * 16) / 4] & 0x1F;
                if(pselp == 0) continue;
                if(amount >= max) break;
                var config = regs[(0x518 + ch * 16) / 4];
                double volts = pselp == 9 ? 3.3 : (FaberBridge.Instance?.AnalogMv(name, (int)pselp - 1) ?? 0) / 1000.0; // AIN0..7 = 1..8, VDD = 9
                var gain = new[] { 1.0 / 6, 1.0 / 5, 1.0 / 4, 1.0 / 3, 1.0 / 2, 1.0, 2.0, 4.0 }[(config >> 8) & 7];
                var reference = ((config >> 12) & 1) == 1 ? 3.3 / 4 : 0.6;
                var full = 1 << resBits;
                var code = (int)Math.Round(volts * gain / reference * full);
                code = Math.Max(0, Math.Min(full - 1, code));
                machine.SystemBus.WriteWord(ptr + (ulong)(2 * amount), (ushort)(short)code);
                amount++;
            }
            Event(0x10C); // RESULTDONE
            Event(0x108); // DONE
            if(amount >= max) Event(0x104); // END
        }

        private void Event(long offset)
        {
            regs[offset / 4] = 1;
            Update();
        }

        private void Update()
        {
            var inten = regs[0x300 / 4];
            var pending = false;
            for(var i = 0; i < 22; i++)
            {
                if(((inten >> i) & 1) == 0) continue;
                var off = i < 6 ? 0x100 + 4 * i : 0x118 + 4 * (i - 6);
                if(regs[off / 4] != 0) pending = true;
            }
            IRQ.Set(pending);
        }

        private readonly IMachine machine;
        private readonly string name;
        private uint[] regs;
        private int amount;
    }

    public class FaberNrf52Pwm : IDoubleWordPeripheral, IKnownSize
    {
        public FaberNrf52Pwm(IMachine machine, string name = "pwm0")
        {
            this.machine = machine;
            this.name = name;
            IRQ = new GPIO();
            Reset();
        }

        public GPIO IRQ { get; }
        public long Size => 0x1000;

        public void Reset()
        {
            regs = new uint[0x1000 / 4];
            for(var k = 0; k < 4; k++) regs[(0x560 + 4 * k) / 4] = 0xFFFFFFFF;
            reported = new string[4];
            IRQ.Unset();
        }

        public uint ReadDoubleWord(long offset) => offset >= 0 && offset < 0x1000 ? regs[offset / 4] : 0;

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset < 0 || offset >= 0x1000) return;
            switch(offset)
            {
            case 0x004: // STOP
                if(value != 0) { Report(false); Event(0x104); }
                return;
            case 0x008:
            case 0x00C: // SEQSTART[n]
                if(value != 0)
                {
                    var n = (int)((offset - 0x008) / 4);
                    Event(0x108 + 4 * n);
                    Play(n);
                    Event(0x110 + 4 * n); // SEQEND
                    Event(0x11C); // LOOPSDONE
                    Event(0x118); // PWMPERIODEND
                }
                return;
            case 0x010:
                return;
            case 0x304: regs[0x300 / 4] |= value; Update(); return;
            case 0x308: regs[0x300 / 4] &= ~value; Update(); return;
            case 0x500: // ENABLE
                regs[offset / 4] = value;
                if((value & 1) == 0) Report(false);
                return;
            default:
                regs[offset / 4] = value;
                if(offset >= 0x100 && offset < 0x180) Update();
                return;
            }
        }

        private void Play(int seq)
        {
            var ptr = (ulong)regs[(0x520 + 0x20 * seq) / 4];
            var cnt = regs[(0x524 + 0x20 * seq) / 4] & 0x7FFF;
            if(cnt == 0 || ptr == 0) return;
            var decoder = regs[0x510 / 4] & 3;
            var top = (double)(regs[0x508 / 4] & 0x7FFF);
            var updown = (regs[0x504 / 4] & 1) == 1;
            var clock = 16e6 / (1 << (int)(regs[0x50C / 4] & 7));
            var values = new ushort[4];
            for(var k = 0; k < 4; k++)
            {
                var index = decoder == 0 ? 0 : decoder == 1 ? k / 2 : decoder == 2 ? k : k;
                if(index >= cnt) index = 0;
                values[k] = machine.SystemBus.ReadWord(ptr + (ulong)(2 * index));
            }
            if(decoder == 3) top = Math.Max(1, values[3] & 0x7FFF); // waveform: the 4th value is TOP
            var periodNs = (updown ? 2 : 1) * top / clock * 1e9;
            for(var k = 0; k < 4; k++)
            {
                var psel = regs[(0x560 + 4 * k) / 4];
                if((psel >> 31) == 1) continue; // not connected
                var compare = Math.Min(top, values[k] & 0x7FFF);
                var fallingFirst = (values[k] & 0x8000) != 0; // POLARITY 1: high from the start of the period until COMPARE
                var high = fallingFirst ? compare / top : 1 - compare / top;
                var pin = $"{(psel >> 5) & 1}.{psel & 0x1F}";
                var line = $"P {pin} {(ulong)Math.Round(periodNs)} {(ulong)Math.Round(periodNs * high)}";
                if(reported[k] == line) continue;
                reported[k] = line;
                var b = FaberBridge.Instance;
                b?.Send($"{line} {b.Now}");
            }
        }

        private void Report(bool on)
        {
            for(var k = 0; k < 4; k++)
            {
                if(reported[k] == null) continue;
                var psel = regs[(0x560 + 4 * k) / 4];
                var b = FaberBridge.Instance;
                b?.Send($"P {(psel >> 5) & 1}.{psel & 0x1F} 0 0 {b.Now}");
                reported[k] = null;
            }
        }

        private void Event(long offset)
        {
            regs[offset / 4] = 1;
            Update();
        }

        private void Update()
        {
            var inten = regs[0x300 / 4];
            var pending = false;
            for(var i = 1; i < 8; i++)
            {
                if(((inten >> i) & 1) == 0) continue;
                if(regs[(0x100 + 4 * i) / 4] != 0) pending = true;
            }
            IRQ.Set(pending);
        }

        private readonly IMachine machine;
        private readonly string name;
        private uint[] regs;
        private string[] reported;
    }
}
