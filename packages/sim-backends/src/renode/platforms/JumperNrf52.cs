// nRF52840 peripherals Renode 1.17 does not model, for Jumper (MIT, like Renode):
//   JumperNrf52Saadc  SAADC (analogRead): single-ended channels, EasyDMA results, gain / reference /
//                     resolution as configured; the input is the voltage Jumper set on the AIN pin.
//   JumperNrf52Pwm    PWM0..3 (analogWrite, Servo, tone): reads the first value of the sequence from
//                     RAM and tells Jumper each connected pin's period and high time ("P" line); Jumper
//                     draws the edges. Events (SEQSTARTED / SEQEND / STOPPED / LOOPSDONE) fire at once.
// Not modelled: differential inputs, oversampling, the analog limits, burst and continuous sampling
// (SAADC); per-step sequence playback, NEXTSTEP, PWM waveform mode's per-period TOP (PWM).
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class JumperNrf52Saadc : IDoubleWordPeripheral, IKnownSize
    {
        public JumperNrf52Saadc(IMachine machine, string name = "saadc")
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
                double volts = pselp == 9 ? 3.3 : (JumperBridge.Instance?.AnalogMv(name, (int)pselp - 1) ?? 0) / 1000.0; // AIN0..7 = 1..8, VDD = 9
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

    public class JumperNrf52Pwm : IDoubleWordPeripheral, IKnownSize
    {
        public JumperNrf52Pwm(IMachine machine, string name = "pwm0")
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
                var b = JumperBridge.Instance;
                b?.Send($"{line} {b.Now}");
            }
        }

        private void Report(bool on)
        {
            for(var k = 0; k < 4; k++)
            {
                if(reported[k] == null) continue;
                var psel = regs[(0x560 + 4 * k) / 4];
                var b = JumperBridge.Instance;
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
