# Test these on the real device: claude-ai-pet

3 exact, 7 behavioral, 0 stub parts. Logic is ok; approximate or missing: timing, analog, power, radio. Check the 20 items in testOnRealDevice on hardware before trusting it.

- [ ] uno (arduino-uno): Total current from many pins (200 mA package limit)
- [ ] uno (arduino-uno): Anything powered from VIN or the 3.3 V pin (50 mA max)
- [ ] uno (arduino-uno): Analog readings near the input thresholds
- [ ] uno (arduino-uno): Upload through the bootloader (arduino-cli upload)
- [ ] tft1 (ili9341-tft): Colours: some modules are RGB instead of BGR (red and blue swapped): try tft.invertDisplay() or a different MADCTL
- [ ] tft1 (ili9341-tft): Logic level: bare red modules are 3.3 V logic; on a 5 V Uno use a level shifter (74HC4050) or the module can fail over time
- [ ] tft1 (ili9341-tft): Long SPI wires above 15 cm corrupt pixels at 8 MHz; shorten them or lower the SPI clock
- [ ] tft1 (ili9341-tft): Backlight current (60 to 100 mA) from the Uno 5 V pin together with Wi-Fi and servos
- [ ] wifi1 (esp01-wifi): Power the ESP-01 from a 3.3 V regulator that gives 300 mA (AMS1117-3.3 with 10 µF + 100 nF), not the Uno 3V3 pin: random resets and 'busy p...' are the symptom
- [ ] wifi1 (esp01-wifi): Put a 1 kΩ / 2 kΩ divider on the module's RX
- [ ] wifi1 (esp01-wifi): Set the module to 9600 baud once (AT+UART_DEF=9600,8,1,0,0) before using SoftwareSerial
- [ ] wifi1 (esp01-wifi): Your Wi-Fi name and password in the sketch, and the gateway's LAN address (http://<your-computer>:8787) instead of ai.jumper
- [ ] wifi1 (esp01-wifi): Check the AT firmware version with AT+GMR: 1.7.x matches the sandbox; very old 0.9.x firmware answers differently
- [ ] btnTalk (pushbutton): Debounce logic (real buttons bounce)
- [ ] btnTalk (pushbutton): Long-press / double-click timing
- [ ] buzzer1 (buzzer): Loudness at 3.3 V
- [ ] buzzer1 (buzzer): Driving with tone() or PWM (active buzzers can sound distorted)
- [ ] rdiv1 (resistor): Circuits that depend on precise resistor ratios (use 1 % parts or trim)
- [ ] rdiv1 (resistor): Resistors dissipating close to their power rating
- [ ] Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).

## Simulator limits

- Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).
- All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.
- Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.
