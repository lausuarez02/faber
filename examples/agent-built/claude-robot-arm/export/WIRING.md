# Wiring: claude-arm

| # | From | To | Colour |
| --- | --- | --- | --- |
| 1 | shoulder.SIG (PWM (orange)) | uno.D9 (~9) | #FFB23F |
| 2 | shoulder.VCC (V+ (red)) | uno.5V | #FF4D2E |
| 3 | shoulder.GND (GND (brown)) | uno.GND.1 (GND) | #2B3038 |
| 4 | elbow.SIG (PWM (orange)) | uno.D10 (~10) | #B47CFF |
| 5 | elbow.VCC (V+ (red)) | shoulder.VCC (V+ (red)) | #FF4D2E |
| 6 | elbow.GND (GND (brown)) | shoulder.GND (GND (brown)) | #2B3038 |
| 7 | pot1.W | uno.A0 | #FFB23F |
| 8 | pot1.1 | uno.GND.2 (GND) | #2B3038 |
| 9 | pot1.2 | shoulder.VCC (V+ (red)) | #FF4D2E |
| 10 | pot2.W | uno.A1 | #B47CFF |
| 11 | pot2.1 | pot1.1 | #E9EDF2 |
| 12 | pot2.2 | pot1.2 | #5CF2A1 |
| 13 | btnrec.1a | uno.D2 (2) | #FFB23F |
| 14 | btnrec.2a | uno.GND.3 (GND) | #2B3038 |
| 15 | btnplay.1a | uno.D3 (~3) | #F2E14A |
| 16 | btnplay.2a | btnrec.2a | #B47CFF |

## Nets (everything on one line is electrically connected)

- btnplay.1a · uno.D3 (~3)
- btnplay.2a · btnrec.2a · uno.GND.3 (GND)
- btnrec.1a · uno.D2 (2)
- elbow.GND (GND (brown)) · shoulder.GND (GND (brown)) · uno.GND.1 (GND)
- elbow.SIG (PWM (orange)) · uno.D10 (~10)
- elbow.VCC (V+ (red)) · pot1.2 · pot2.2 · shoulder.VCC (V+ (red)) · uno.5V
- pot1.1 · pot2.1 · uno.GND.2 (GND)
- pot1.W · uno.A0
- pot2.W · uno.A1
- shoulder.SIG (PWM (orange)) · uno.D9 (~9)
