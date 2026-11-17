// STM32F1 ADC (RM0008 section 11) for Renode, which has no F1 ADC model. Enough for STM32duino's
// analogRead (HAL): power on, reset calibration and calibration finish at once, a regular
// conversion of the first channel in SQR3 starts on SWSTART (or on a second ADON write) and is done
// at once: DR = the voltage Faber last set on that channel (FaberBridge "A" line), 12-bit against
// a 3.3 V reference, EOC set until DR is read. Internal channels: 16 = temperature (25 C, 1.43 V),
// 17 = VREFINT (1.20 V). Not modelled: scan / continuous / injected groups, DMA, the analog
// watchdog, sampling time, conversion time and noise.
using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class FaberStm32F1Adc : IDoubleWordPeripheral, IKnownSize
    {
        public FaberStm32F1Adc(IMachine machine, string name = "adc1")
        {
            this.name = name;
            Reset();
        }

        public long Size => 0x400;

        public void Reset()
        {
            regs = new uint[0x50 / 4];
        }

        public uint ReadDoubleWord(long offset)
        {
            if(offset < 0 || offset >= 0x50) return 0;
            var v = regs[offset / 4];
            if(offset == DR) regs[SR / 4] &= ~EOC;
            return v;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset < 0 || offset >= 0x50) return;
            switch(offset)
            {
            case SR:
                regs[SR / 4] &= value; // rc_w0
                return;
            case CR2:
            {
                var old = regs[CR2 / 4];
                var wasOn = (old & ADON) != 0;
                var swStart = (value & SWSTART) != 0;
                // RM0008: setting ADON again starts a conversion, unless another bit changes in the same write.
                var adonAgain = wasOn && (value & ADON) != 0 && ((value ^ old) & ~(ADON | SWSTART)) == 0;
                regs[CR2 / 4] = value & ~(SWSTART | CAL | RSTCAL); // calibration finishes at once
                if((value & ADON) != 0 && (swStart || adonAgain)) Convert();
                return;
            }
            case DR:
                return;
            default:
                regs[offset / 4] = value;
                return;
            }
        }

        private void Convert()
        {
            var channel = (int)(regs[SQR3 / 4] & 0x1F);
            int mv;
            if(channel == 16) mv = 1430;
            else if(channel == 17) mv = 1200;
            else mv = FaberBridge.Instance?.AnalogMv(name, channel) ?? 0;
            var code = (uint)System.Math.Max(0, System.Math.Min(4095, System.Math.Round(mv * 4095.0 / 3300.0)));
            if((regs[CR2 / 4] & ALIGN) != 0) code <<= 4;
            regs[DR / 4] = code;
            regs[SR / 4] |= EOC | STRT;
        }

        private uint[] regs;
        private readonly string name;

        private const long SR = 0x00, CR2 = 0x08, SQR3 = 0x34, DR = 0x4C;
        private const uint EOC = 1u << 1, STRT = 1u << 4;
        private const uint ADON = 1u << 0, CAL = 1u << 2, RSTCAL = 1u << 3, ALIGN = 1u << 11, SWSTART = 1u << 22;
    }
}
