# Assembly (soldered): Pocket Muse

Hand-wired point to point (or on perfboard), no breadboard. Pin names are the ones on the parts' silkscreen as in WIRING.md.

1. Cut and strip every wire in WIRE-CUTS.csv (22 wires; 5 mm stripped at each end, then tinned). The lengths are estimated from the part sizes: lay the parts in the case first and trim them shorter if they fit tighter.
2. Leave bat (LiPo battery 1S (3.7 V, with protection)) unplugged until step 4. Never let its two wires touch.
3. Solder the power path first (24 AWG):
   - w17: bat.POS → chg.BAT, red, 95 mm, 24 AWG
   - w18: bat.NEG → chg.GND.2, black, 95 mm, 24 AWG
   - w19: chg.GND.3 → xiao.GND.1, black, 80 mm, 24 AWG
   - w20: chg.OUT → pwr.2, red, 65 mm, 24 AWG
   - w21: pwr.1 → d1.A, red, 45 mm, 24 AWG
   - w22: d1.C → xiao.VBUS, red, 60 mm, 24 AWG
   d1 (Schottky diode (1N5817, 1 A 20 V)): the end with the stripe (C) goes towards xiao. Slide heat-shrink over it.
4. Test the power path before anything else is connected to it: plug bat in, switch on and measure xiao's supply pin against GND with a multimeter (a 1S LiPo through a Schottky diode reads about 3.4 to 3.9 V; 0 V means the diode or the cell is the wrong way round). Switch off and unplug the battery again.
5. Solder the modules' power and ground (24 AWG):
   - w1: eye.VCC → xiao.3V3, red, 95 mm, 24 AWG
   - w2: eye.GND → xiao.GND.1, black, 95 mm, 24 AWG
   - w9: imu.VCC → xiao.3V3, red, 75 mm, 24 AWG
   - w10: imu.GND → xiao.GND.1, black, 75 mm, 24 AWG
   - w14: pet.2a → xiao.GND.1, black, 60 mm, 24 AWG
   - w16: squeak.NEG → xiao.GND.1, black, 65 mm, 24 AWG
6. Solder the signal wires (26 AWG):
   - w3: eye.SCK → xiao.GP2, yellow, 95 mm, 26 AWG
   - w4: eye.MOSI → xiao.GP3, purple, 90 mm, 26 AWG
   - w5: eye.CS → xiao.GP1, white, 95 mm, 26 AWG
   - w6: eye.DC → xiao.GP29, green, 95 mm, 26 AWG
   - w7: eye.RST → xiao.GP28, orange, 90 mm, 26 AWG
   - w11: imu.SDA → xiao.GP6, white, 70 mm, 26 AWG
   - w12: imu.SCL → xiao.GP7, green, 75 mm, 26 AWG
   - w13: pet.1a → xiao.GP26, orange, 60 mm, 26 AWG
   - w15: squeak.POS → xiao.GP27, yellow, 65 mm, 26 AWG
   - w8: eye.LED → xiao.GP0, blue, 95 mm, 26 AWG
7. Insulate every joint that could touch another (heat-shrink), and check with a multimeter that the supply and GND are not shorted (more than a few hundred Ω between them with the switch off).
8. Flash the firmware: hold BOOT while plugging the board into USB, then copy firmware.uf2 to the drive that appears (see the export's flash line).
9. Switch on and go through TEST-ON-HARDWARE.md.
