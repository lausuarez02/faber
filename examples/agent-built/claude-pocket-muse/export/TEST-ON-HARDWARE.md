# Test these on the real device: Pocket Muse

0 exact, 9 behavioral, 0 stub parts. Logic is ok; approximate or missing: timing, analog, power. Check the 26 items in testOnRealDevice on hardware before trusting it.

- [ ] xiao (seeed-xiao-rp2040): Anything that uses core 1 (setup1/loop1, multicore FIFO)
- [ ] xiao (seeed-xiao-rp2040): Analog readings: the RP2040 ADC is noisy and non-linear near codes 512, 1536, 2560 and 3584
- [ ] xiao (seeed-xiao-rp2040): Total current from many pins (50 mA for all GPIOs together)
- [ ] xiao (seeed-xiao-rp2040): Every 5 V part: RP2040 pins are not 5 V tolerant; use a level shifter
- [ ] xiao (seeed-xiao-rp2040): Upload by BOOTSEL / UF2 and USB enumeration on your computer
- [ ] xiao (seeed-xiao-rp2040): Loads on the 3V3 pin
- [ ] eye (gc9a01-round-tft): The init sequence your library sends (Adafruit_GC9A01A / TFT_eSPI are known good)
- [ ] eye (gc9a01-round-tft): Logic level on a 5 V board (most modules are 3.3 V only)
- [ ] eye (gc9a01-round-tft): Colours: if they look inverted, the driver did not send INVON
- [ ] imu (mpu6050): Offset calibration: real gyros read a few °/s at rest
- [ ] imu (mpu6050): Vibration and noise on a moving robot (motors couple into the accelerometer)
- [ ] imu (mpu6050): DMP-based sketches (MPU6050_DMP6) and interrupt-driven reads
- [ ] pet (pushbutton): Debounce logic (real buttons bounce)
- [ ] pet (pushbutton): Long-press / double-click timing
- [ ] squeak (passive-buzzer): Loudness at the notes you use (piezos are quiet far below their resonance)
- [ ] squeak (passive-buzzer): That your buzzer really is passive: an active one beeps at its own pitch on DC
- [ ] bat (lipo-battery): Real run time: measure the average current of your device and divide the capacity by it, then keep a 20 % margin
- [ ] bat (lipo-battery): The voltage your firmware reads near empty (3.3–3.5 V) and that it shuts down in time
- [ ] bat (lipo-battery): Charge only with a LiPo charger; never leave a charging LiPo unattended
- [ ] chg (tp4056-charger): Set R_PROG for your cell (≤ 1C) before the first charge
- [ ] chg (tp4056-charger): How hot the module gets at your charge current
- [ ] chg (tp4056-charger): That your device works while charging (load on OUT during CC/CV)
- [ ] pwr (slide-switch): Debounce when the switch selects modes in firmware
- [ ] d1 (schottky-diode): Measure the drop at your real load (VBUS vs the cell)
- [ ] d1 (schottky-diode): That the stripe faces the board: reversed, the device never powers on from the battery
- [ ] Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).

## Simulator limits

- Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).
- All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.
- Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.
