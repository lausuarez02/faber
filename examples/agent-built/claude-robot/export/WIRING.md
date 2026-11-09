# Wiring: Explorer Bot

| # | From | To | Colour |
| --- | --- | --- | --- |
| 1 | batt.POS (+) | drv.12V (12V (VS)) | #FF4D2E |
| 2 | batt.POS (+) | uno.VIN | #FF4D2E |
| 3 | batt.NEG (−) | drv.GND | #2B3038 |
| 4 | drv.GND | uno.GND.1 (GND) | #2B3038 |
| 5 | uno.D5 (~5) | drv.ENA | #E9EDF2 |
| 6 | uno.D7 (7) | drv.IN1 | #5CF2A1 |
| 7 | uno.D8 (8) | drv.IN2 | #FFB23F |
| 8 | uno.D6 (~6) | drv.ENB | #4DA3FF |
| 9 | uno.D2 (2) | drv.IN3 | #F2E14A |
| 10 | uno.D3 (~3) | drv.IN4 | #B47CFF |
| 11 | drv.OUT1 | motorL.A (M+) | #E9EDF2 |
| 12 | drv.OUT2 | motorL.B (M−) | #5CF2A1 |
| 13 | drv.OUT3 | motorR.A (M+) | #FFB23F |
| 14 | drv.OUT4 | motorR.B (M−) | #4DA3FF |
| 15 | sonar1.VCC | uno.5V | #FF4D2E |
| 16 | sonar1.GND | uno.GND.2 (GND) | #2B3038 |
| 17 | uno.D9 (~9) | sonar1.TRIG | #E9EDF2 |
| 18 | sonar1.ECHO | uno.D10 (~10) | #5CF2A1 |
| 19 | oled1.VCC | uno.5V | #FF4D2E |
| 20 | oled1.GND | uno.GND.3 (GND) | #2B3038 |
| 21 | oled1.SDA | uno.A4 | #F2E14A |
| 22 | oled1.SCL | uno.A5 | #B47CFF |
| 23 | drv.5V | uno.5V | #FF4D2E |

## Nets (everything on one line is electrically connected)

- batt.NEG (−) · drv.GND · uno.GND.1 (GND)
- batt.POS (+) · drv.12V (12V (VS)) · uno.VIN
- drv.5V · oled1.VCC · sonar1.VCC · uno.5V
- drv.ENA · uno.D5 (~5)
- drv.ENB · uno.D6 (~6)
- drv.IN1 · uno.D7 (7)
- drv.IN2 · uno.D8 (8)
- drv.IN3 · uno.D2 (2)
- drv.IN4 · uno.D3 (~3)
- drv.OUT1 · motorL.A (M+)
- drv.OUT2 · motorL.B (M−)
- drv.OUT3 · motorR.A (M+)
- drv.OUT4 · motorR.B (M−)
- oled1.GND · uno.GND.3 (GND)
- oled1.SCL · uno.A5
- oled1.SDA · uno.A4
- sonar1.ECHO · uno.D10 (~10)
- sonar1.GND · uno.GND.2 (GND)
- sonar1.TRIG · uno.D9 (~9)
