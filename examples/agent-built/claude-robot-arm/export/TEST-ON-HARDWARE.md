# Test these on the real device: claude-arm

0 exact, 7 behavioral, 0 stub parts. Logic is ok; approximate or missing: timing, analog, power. Check the 12 items in testOnRealDevice on hardware before trusting it.

- [ ] uno (arduino-uno): Total current from many pins (200 mA package limit)
- [ ] uno (arduino-uno): Anything powered from VIN or the 3.3 V pin (50 mA max)
- [ ] uno (arduino-uno): Analog readings near the input thresholds
- [ ] uno (arduino-uno): Upload through the bootloader (arduino-cli upload)
- [ ] shoulder (servo-sg90): The real pulse range of your servo (end stops buzz when driven past them)
- [ ] shoulder (servo-sg90): Brown-outs when several servos move at once on the Arduino 5 V (use a separate 5–6 V supply)
- [ ] shoulder (servo-sg90): Holding torque under your load
- [ ] pot1 (potentiometer): Readings near the end stops
- [ ] pot1 (potentiometer): Noise on analogRead (add averaging)
- [ ] btnrec (pushbutton): Debounce logic (real buttons bounce)
- [ ] btnrec (pushbutton): Long-press / double-click timing
- [ ] Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).

## Simulator limits

- Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).
- All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.
- Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.
