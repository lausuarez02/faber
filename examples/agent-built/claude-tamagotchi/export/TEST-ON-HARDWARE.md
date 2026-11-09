# Test these on the real device: tamagotchi

0 exact, 6 behavioral, 0 stub parts. Logic is ok; approximate or missing: timing, analog, power. Check the 13 items in testOnRealDevice on hardware before trusting it.

- [ ] uno (arduino-uno): Total current from many pins (200 mA package limit)
- [ ] uno (arduino-uno): Anything powered from VIN or the 3.3 V pin (50 mA max)
- [ ] uno (arduino-uno): Analog readings near the input thresholds
- [ ] uno (arduino-uno): Upload through the bootloader (arduino-cli upload)
- [ ] oled1 (ssd1306-oled-i2c): Scrolling effects (startscrollright and friends)
- [ ] oled1 (ssd1306-oled-i2c): Which address your module really uses (check the jumper on the back; some are labelled 0x78/0x7A, which is 0x3C/0x3D shifted left)
- [ ] oled1 (ssd1306-oled-i2c): Readability of the contrast setting in daylight
- [ ] oled1 (ssd1306-oled-i2c): Supply current if you run from a battery
- [ ] btnFeed (pushbutton): Debounce logic (real buttons bounce)
- [ ] btnFeed (pushbutton): Long-press / double-click timing
- [ ] buzzer1 (buzzer): Loudness at 3.3 V
- [ ] buzzer1 (buzzer): Driving with tone() or PWM (active buzzers can sound distorted)
- [ ] Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).

## Simulator limits

- Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).
- All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.
- Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.
