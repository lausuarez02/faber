# Test these on the real device: Explorer Bot

0 exact, 8 behavioral, 0 stub parts. Logic is ok; approximate or missing: timing, analog, power. Check the 25 items in testOnRealDevice on hardware before trusting it.

- [ ] uno (arduino-uno): Total current from many pins (200 mA package limit)
- [ ] uno (arduino-uno): Anything powered from VIN or the 3.3 V pin (50 mA max)
- [ ] uno (arduino-uno): Analog readings near the input thresholds
- [ ] uno (arduino-uno): Upload through the bootloader (arduino-cli upload)
- [ ] chassis1 (robot-chassis-2wd): Straight-line drift (motors differ, add a trim)
- [ ] chassis1 (robot-chassis-2wd): Turning radius on your floor
- [ ] chassis1 (robot-chassis-2wd): Whether the sensor sees low obstacles below its mount height
- [ ] drv (l298n): Motor speed at low PWM duty (L298N loses torque below ~30 % duty)
- [ ] drv (l298n): Chip temperature at your motor current
- [ ] drv (l298n): Whether the motors reset the Arduino when they start (separate supplies, common ground)
- [ ] motorL (dc-motor): Whether both motors run at the same speed (calibrate a per-motor PWM trim)
- [ ] motorL (dc-motor): Minimum PWM that starts the motor under load
- [ ] motorL (dc-motor): Supply brown-out on the Arduino when motors start (use a separate battery for the motors)
- [ ] batt (battery-pack): Run time with your motors (capacity)
- [ ] batt (battery-pack): Brown-out of the Arduino when motors start on a shared pack
- [ ] batt (battery-pack): Never discharge a LiPo below 3.0 V per cell
- [ ] sonar1 (hc-sr04): Readings on soft (fabric), round or angled obstacles
- [ ] sonar1 (hc-sr04): Readings closer than 3 cm
- [ ] sonar1 (hc-sr04): Two sensors pinging at the same time
- [ ] sonar1 (hc-sr04): Ping rate faster than every 60 ms
- [ ] oled1 (ssd1306-oled-i2c): Scrolling effects (startscrollright and friends)
- [ ] oled1 (ssd1306-oled-i2c): Which address your module really uses (check the jumper on the back; some are labelled 0x78/0x7A, which is 0x3C/0x3D shifted left)
- [ ] oled1 (ssd1306-oled-i2c): Readability of the contrast setting in daylight
- [ ] oled1 (ssd1306-oled-i2c): Supply current if you run from a battery
- [ ] Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).

## Simulator limits

- Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).
- All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.
- Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.
