# Wiring: codex-rover-r2

| # | From | To | Colour |
| --- | --- | --- | --- |
| 1 | battery.POS (+) | driver.12V (12V (VS)) | #FF4D2E |
| 2 | battery.POS (+) | uno.VIN | #FF4D2E |
| 3 | battery.NEG (−) | driver.GND | #2B3038 |
| 4 | driver.GND | uno.GND.1 (GND) | #2B3038 |
| 5 | uno.5V | driver.5V | #FF4D2E |
| 6 | driver.OUT1 | left.A (M+) | #5CF2A1 |
| 7 | driver.OUT2 | left.B (M−) | #FFB23F |
| 8 | driver.OUT3 | right.A (M+) | #4DA3FF |
| 9 | driver.OUT4 | right.B (M−) | #F2E14A |
| 10 | uno.D5 (~5) | driver.ENA | #B47CFF |
| 11 | uno.D6 (~6) | driver.ENB | #E9EDF2 |
| 12 | uno.D7 (7) | driver.IN1 | #5CF2A1 |
| 13 | uno.D8 (8) | driver.IN2 | #FFB23F |
| 14 | uno.D11 (~11) | driver.IN3 | #4DA3FF |
| 15 | uno.D12 (12) | driver.IN4 | #F2E14A |
| 16 | uno.5V | sonar.VCC | #FF4D2E |
| 17 | uno.GND.2 (GND) | sonar.GND | #2B3038 |
| 18 | uno.D9 (~9) | sonar.TRIG | #5CF2A1 |
| 19 | uno.D10 (~10) | sonar.ECHO | #FFB23F |

## Nets (everything on one line is electrically connected)

- battery.NEG (−) · driver.GND · uno.GND.1 (GND)
- battery.POS (+) · driver.12V (12V (VS)) · uno.VIN
- driver.5V · sonar.VCC · uno.5V
- driver.ENA · uno.D5 (~5)
- driver.ENB · uno.D6 (~6)
- driver.IN1 · uno.D7 (7)
- driver.IN2 · uno.D8 (8)
- driver.IN3 · uno.D11 (~11)
- driver.IN4 · uno.D12 (12)
- driver.OUT1 · left.A (M+)
- driver.OUT2 · left.B (M−)
- driver.OUT3 · right.A (M+)
- driver.OUT4 · right.B (M−)
- sonar.ECHO · uno.D10 (~10)
- sonar.GND · uno.GND.2 (GND)
- sonar.TRIG · uno.D9 (~9)
