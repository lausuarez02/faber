# Test these on the real device: codex-rover-r2

0 exact, 7 behavioral, 0 stub parts. Logic is ok; approximate or missing: timing, analog, power. Check the 21 items in testOnRealDevice on hardware before trusting it.

- [ ] uno (arduino-uno): Total current from many pins (200 mA package limit)
- [ ] uno (arduino-uno): Anything powered from VIN or the 3.3 V pin (50 mA max)
- [ ] uno (arduino-uno): Analog readings near the input thresholds
- [ ] uno (arduino-uno): Upload through the bootloader (arduino-cli upload)
- [ ] driver (l298n): Motor speed at low PWM duty (L298N loses torque below ~30 % duty)
- [ ] driver (l298n): Chip temperature at your motor current
- [ ] driver (l298n): Whether the motors reset the Arduino when they start (separate supplies, common ground)
- [ ] battery (battery-pack): Run time with your motors (capacity)
- [ ] battery (battery-pack): Brown-out of the Arduino when motors start on a shared pack
- [ ] battery (battery-pack): Never discharge a LiPo below 3.0 V per cell
- [ ] left (dc-motor): Whether both motors run at the same speed (calibrate a per-motor PWM trim)
- [ ] left (dc-motor): Minimum PWM that starts the motor under load
- [ ] left (dc-motor): Supply brown-out on the Arduino when motors start (use a separate battery for the motors)
- [ ] chassis (robot-chassis-2wd): Straight-line drift (motors differ, add a trim)
- [ ] chassis (robot-chassis-2wd): Turning radius on your floor
- [ ] chassis (robot-chassis-2wd): Whether the sensor sees low obstacles below its mount height
- [ ] sonar (hc-sr04): Readings on soft (fabric), round or angled obstacles
- [ ] sonar (hc-sr04): Readings closer than 3 cm
- [ ] sonar (hc-sr04): Two sensors pinging at the same time
- [ ] sonar (hc-sr04): Ping rate faster than every 60 ms
- [ ] Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).

## Simulator limits

- Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).
- All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.
- Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.
