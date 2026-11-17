// STM32F4 SYSCFG for Renode (MIT, like Renode): the EXTI line multiplexer. Every GPIO port feeds its
// 16 pins in (port k pin n = input 16 k + n); EXTICR1..4 pick which port drives each EXTI line, as on
// the chip, so only the chosen pin's edges reach EXTI. MEMRMP / PMC / CMPCR read back what is written.
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class FabwrightStm32Syscfg : IDoubleWordPeripheral, IKnownSize, IGPIOReceiver
    {
        public FabwrightStm32Syscfg(IMachine machine, IGPIOReceiver exti)
        {
            this.exti = exti;
            Reset();
        }

        public long Size => 0x400;

        public void Reset()
        {
            regs = new uint[0x400 / 4];
        }

        public void OnGPIO(int number, bool value)
        {
            state[number] = value;
            var port = number / 16;
            var line = number % 16;
            if(Selected(line) == port) exti.OnGPIO(line, value);
        }

        public uint ReadDoubleWord(long offset) => offset >= 0 && offset < 0x400 ? regs[offset / 4] : 0;

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset < 0 || offset >= 0x400) return;
            var before = new int[16];
            for(var l = 0; l < 16; l++) before[l] = Selected(l);
            regs[offset / 4] = value;
            for(var l = 0; l < 16; l++)
            {
                var now = Selected(l);
                if(now != before[l]) exti.OnGPIO(l, state.TryGetValue(16 * now + l, out var v) && v);
            }
        }

        private int Selected(int line) => (int)((regs[(0x08 + 4 * (line / 4)) / 4] >> (4 * (line % 4))) & 0xF);

        private readonly IGPIOReceiver exti;
        private readonly Dictionary<int, bool> state = new Dictionary<int, bool>();
        private uint[] regs;
    }
}
