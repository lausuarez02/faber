# Wiring: tamagotchi

| # | From | To | Colour |
| --- | --- | --- | --- |
| 1 | oled1.GND | uno.GND.1 (GND) | #2B3038 |
| 2 | oled1.VCC | uno.5V | #FF4D2E |
| 3 | oled1.SCL | uno.A5 | #F2E14A |
| 4 | oled1.SDA | uno.A4 | #B47CFF |
| 5 | btnFeed.1a | uno.D2 (2) | #E9EDF2 |
| 6 | btnFeed.2a | uno.GND.2 (GND) | #2B3038 |
| 7 | btnPlay.1a | uno.D4 (4) | #FFB23F |
| 8 | btnPlay.2a | uno.GND.3 (GND) | #2B3038 |
| 9 | btnSleep.1a | uno.D7 (7) | #F2E14A |
| 10 | btnSleep.2a | uno.GND.1 (GND) | #2B3038 |
| 11 | buzzer1.POS (+) | uno.D8 (8) | #E9EDF2 |
| 12 | buzzer1.NEG (−) | uno.GND.1 (GND) | #2B3038 |

## Nets (everything on one line is electrically connected)

- btnFeed.1a · uno.D2 (2)
- btnFeed.2a · uno.GND.2 (GND)
- btnPlay.1a · uno.D4 (4)
- btnPlay.2a · uno.GND.3 (GND)
- btnSleep.1a · uno.D7 (7)
- btnSleep.2a · buzzer1.NEG (−) · oled1.GND · uno.GND.1 (GND)
- buzzer1.POS (+) · uno.D8 (8)
- oled1.SCL · uno.A5
- oled1.SDA · uno.A4
- oled1.VCC · uno.5V
