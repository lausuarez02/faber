# Wiring: Pocket Muse

| # | From | To | Colour |
| --- | --- | --- | --- |
| 1 | eye.VCC | xiao.3V3 | #FF4D2E |
| 2 | eye.GND | xiao.GND.1 (GND) | #2B3038 |
| 3 | eye.SCK (SCL) | xiao.GP2 (D8/SCK) | #F2E14A |
| 4 | eye.MOSI (SDA) | xiao.GP3 (D10/MOSI) | #B47CFF |
| 5 | eye.CS | xiao.GP1 (D7/RX) | #E9EDF2 |
| 6 | eye.DC | xiao.GP29 (D3/A3) | #5CF2A1 |
| 7 | eye.RST (RES) | xiao.GP28 (D2/A2) | #FFB23F |
| 8 | imu.VCC | xiao.3V3 | #FF4D2E |
| 9 | imu.GND | xiao.GND.1 (GND) | #2B3038 |
| 10 | imu.SDA | xiao.GP6 (D4/SDA) | #E9EDF2 |
| 11 | imu.SCL | xiao.GP7 (D5/SCL) | #5CF2A1 |
| 12 | pet.1a | xiao.GP26 (D0/A0) | #FFB23F |
| 13 | pet.2a | xiao.GND.1 (GND) | #2B3038 |
| 14 | squeak.POS (+) | xiao.GP27 (D1/A1) | #F2E14A |
| 15 | squeak.NEG (−) | xiao.GND.1 (GND) | #2B3038 |
| 16 | bat.POS (+) | chg.BAT (B+) | #FF4D2E |
| 17 | bat.NEG (−) | chg.GND.2 (B−) | #2B3038 |
| 18 | chg.GND.3 (OUT−) | xiao.GND.1 (GND) | #2B3038 |
| 19 | eye.LED (BLK) | xiao.GP0 (D6/TX) | #4DA3FF |
| 20 | chg.OUT (OUT+) | pwr.2 (COM) | #FF4D2E |
| 21 | pwr.1 | d1.A (Anode) | #FF4D2E |
| 22 | d1.C (Cathode (stripe)) | xiao.VBUS (5V) | #FF4D2E |

## Nets (everything on one line is electrically connected)

- bat.NEG (−) · chg.GND.2 (B−)
- bat.POS (+) · chg.BAT (B+)
- chg.GND.3 (OUT−) · eye.GND · imu.GND · pet.2a · squeak.NEG (−) · xiao.GND.1 (GND)
- chg.OUT (OUT+) · pwr.2 (COM)
- d1.A (Anode) · pwr.1
- d1.C (Cathode (stripe)) · xiao.VBUS (5V)
- eye.CS · xiao.GP1 (D7/RX)
- eye.DC · xiao.GP29 (D3/A3)
- eye.LED (BLK) · xiao.GP0 (D6/TX)
- eye.MOSI (SDA) · xiao.GP3 (D10/MOSI)
- eye.RST (RES) · xiao.GP28 (D2/A2)
- eye.SCK (SCL) · xiao.GP2 (D8/SCK)
- eye.VCC · imu.VCC · xiao.3V3
- imu.SCL · xiao.GP7 (D5/SCL)
- imu.SDA · xiao.GP6 (D4/SDA)
- pet.1a · xiao.GP26 (D0/A0)
- squeak.POS (+) · xiao.GP27 (D1/A1)
