# I2C and SPI buses

How bus parts (OLEDs, LCD backpacks, RTCs, sensors) talk to the simulated MCU, for part authors
and for anyone driving the simulator from code or an agent.

## The model in one paragraph

Buses are **logical**: they carry whole bytes, not SDA/SCL edges. The MCU backend's bus
peripheral (AVR TWI and SPI in `@fabwright/sim-backends`) is the master. It calls an `I2cBus` /
`SpiBus` from `@fabwright/sim-core` at the moment each START, address, data byte or STOP completes
on the wire, using real timing (I2C: one SCL period per START/STOP and nine per byte, from
`TWBR` and the prescaler, so 90 µs per byte at Wire's 100 kHz; SPI: the `SPCR`/`SPSR` clock
divider). Part models answer as targets. The electrical side (pull-ups, supply, power) stays in
the DC circuit like everything else.

## Wiring rules the Simulation applies

When a project is instantiated (and after `reset()`), every part whose model has an `i2c`
member is attached to the board's I2C bus **if** its pin with protocol `i2c-sda` is on the same
net as a board pin with protocol `i2c-sda` (Uno: `A4`), and the same for `i2c-scl` (`A5`).
SPI parts need `spi-mosi` and `spi-sck` on the board's nets (Uno: `D11`, `D13`; `D12` is MISO),
and are selected while their `spi-cs` net reads below 0.3·VCC (or is tied to GND).

If something is wrong the part gets a diagnostic, in `sim.diagnostics()`, that says what, why and
how to fix it:

| Code | Severity | When |
| --- | --- | --- |
| `i2c-not-connected` | error | SDA or SCL is not on the board's SDA/SCL net (lists the missing wires) |
| `i2c-swapped` | error | SDA goes to SCL and SCL to SDA |
| `i2c-address-conflict` | error | two attached devices answer the same address |
| `i2c-weak-pullups` | info | no module on the bus has pull-ups and no resistor is wired on SDA |
| `i2c-unsupported` / `spi-unsupported` | error | the firmware board's backend has no such bus |
| `i2c-no-mcu` / `spi-no-mcu` | warning | no firmware board is running |
| `spi-not-connected` | error | MOSI/SCK (or a wired MISO) is not on the board's pins |
| `spi-cs-unwired` | error | the chip-select pin is not wired |
| `i2c-module-unpowered` | error | (from the module) VCC/GND are not powered, so it NACKs |

## Faults

`sim.setBusFault(partId, fault | null)` (faults survive `reset()`):

| Fault | I2C | SPI | What the firmware sees |
| --- | --- | --- | --- |
| `nack` | yes | | address NACK: `Wire.endTransmission()` returns 2, scanners do not find it |
| `nack-data` | yes | | address ACK, data NACK: `endTransmission()` returns 3 |
| `disconnect` | yes | yes | nothing answers, the model sees no traffic |
| `garbage` | yes | yes | reads return 0xFF |

Throws a readable error for an unknown part, a part that is not on a bus, or a fault that does
not apply to that bus.

## Observing the bus

- `sim.i2c.list()`: attached devices `{ partId, address, fault? }`.
- `sim.i2c.transactions()`: the last 512 transactions `{ cycle, address, read, ack, partId,
  bytes (first 32), count, dataNack }`. `sim.i2c.onTransaction(cb)` streams them.
- `sim.spi.list()`, `sim.spi.bytes`.
- Display parts expose their screen in `visualState()`: the SSD1306 as `pixels` (base64, 1 bit
  per pixel, row-major, MSB left) with `width`/`height`/`frame`/`lit`/`blank`; the LCD as
  `line0`/`line1` text plus `glyphs`/`cgram` for renderers. `decodeMonoFrame()` and
  `monoToAscii()` in `@fabwright/sim-core` turn an OLED frame into pixels or ASCII art.

## Writing a bus part

1. `part.json`: mark the bus pins with `protocols` (`i2c-sda`, `i2c-scl`, `spi-mosi`,
   `spi-miso`, `spi-sck`, `spi-cs`) and add a `bus` block:
   ```json
   "bus": { "i2c": { "addresses": [60, 61], "addressProp": "address", "pullUpOhms": 4700, "maxHz": 400000 } }
   ```
   `addresses` lists every address the part can have (first = default); `pullUpOhms` only when
   the module really has pull-ups on board.
2. `model.ts`: return an `i2c: I2cDevice` (or `spi: SpiDevice`) member from `create()`:
   ```ts
   i2c: {
     i2cAddress: () => 0x68,
     i2cConnect: (read, repeated) => powered,   // ACK the address?
     i2cWrite: (byte) => true,                  // ACK the byte?
     i2cRead: (masterAcks) => nextByte(),
     i2cStop: () => {},
   }
   ```
   `packages/parts/src/lib/i2cModule.ts` does the module plumbing: supply load, on-board
   pull-ups, address prop, "unpowered" and "over-voltage" diagnostics.
3. `example.ino` next to the part, built with `toolchains/arduino/build-part-examples.sh` into a
   golden `example.hex`, and a `model.test.ts` that runs it with `unoBench()` from
   `src/lib/firmwareBench.ts`. A bus part is only done when a real library talks to it.
