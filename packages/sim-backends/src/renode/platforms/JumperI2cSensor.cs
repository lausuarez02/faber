// Jumper spike: a fake I2C register sensor compiled into Renode at runtime (`include @JumperI2cSensor.cs`).
// Register pointer write, then reads stream 16-bit big-endian registers. `Value` is settable from the
// monitor (`sysbus.i2c1.sensor Value 0x0190`) so Jumper can drive the reading from outside.
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.I2C;

namespace Antmicro.Renode.Peripherals.Sensors
{
    public class JumperI2cSensor : II2CPeripheral
    {
        public JumperI2cSensor() { Reset(); }

        public ushort Value { get; set; } = 0x1234;
        public int Transactions { get; private set; }

        public void Write(byte[] data)
        {
            if(data.Length > 0) pointer = data[0];
            cursor = 0;
            this.Log(LogLevel.Debug, "write {0} bytes, pointer=0x{1:X}", data.Length, pointer);
        }

        public byte[] Read(int count = 1)
        {
            Transactions++;
            var r = new List<byte>();
            ushort v = pointer == 0 ? Value : (ushort)(0xA500 | pointer);
            for(var i = 0; i < count; i++, cursor++) r.Add(cursor % 2 == 0 ? (byte)(v >> 8) : (byte)v);
            this.Log(LogLevel.Debug, "read {0} bytes -> 0x{1:X4}", count, v);
            return r.ToArray();
        }

        public void FinishTransmission() { cursor = 0; }

        public void Reset() { pointer = 0; cursor = 0; }

        private byte pointer;
        private int cursor;
    }
}
