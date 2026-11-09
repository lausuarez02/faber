# Wiring: claude-ai-pet

| # | From | To | Colour |
| --- | --- | --- | --- |
| 1 | tft1.VCC | uno.5V | #FF4D2E |
| 2 | tft1.GND | uno.GND.1 (GND) | #2B3038 |
| 3 | tft1.CS | uno.D10 (~10) | #F2E14A |
| 4 | tft1.DC (DC/RS) | uno.D9 (~9) | #B47CFF |
| 5 | tft1.RST (RESET) | uno.D8 (8) | #E9EDF2 |
| 6 | tft1.MOSI (SDI(MOSI)) | uno.D11 (~11) | #5CF2A1 |
| 7 | tft1.SCK | uno.D13 (13) | #FFB23F |
| 8 | tft1.MISO (SDO(MISO)) | uno.D12 (12) | #4DA3FF |
| 9 | tft1.LED | uno.5V | #FF4D2E |
| 10 | wifi1.VCC (3V3) | uno.3V3 (3.3V) | #FF4D2E |
| 11 | wifi1.GND | uno.GND.2 (GND) | #2B3038 |
| 12 | uno.D3 (~3) | rdiv1.1 | #FFB23F |
| 13 | rdiv1.2 | wifi1.RX | #4DA3FF |
| 14 | wifi1.RX | rdiv2.1 | #F2E14A |
| 15 | rdiv2.2 | uno.GND.3 (GND) | #2B3038 |
| 16 | btnTalk.1a | uno.D4 (4) | #E9EDF2 |
| 17 | btnTalk.2a | uno.GND.1 (GND) | #2B3038 |
| 18 | btnFeed.1a | uno.D5 (~5) | #FFB23F |
| 19 | btnFeed.2a | uno.GND.2 (GND) | #2B3038 |
| 20 | btnPlay.1a | uno.D6 (~6) | #F2E14A |
| 21 | btnPlay.2a | uno.GND.3 (GND) | #2B3038 |
| 22 | buzzer1.POS (+) | uno.D7 (7) | #E9EDF2 |
| 23 | buzzer1.NEG (−) | uno.GND.1 (GND) | #2B3038 |
| 24 | wifi1.TX | rtx.1 | #5CF2A1 |
| 25 | rtx.2 | uno.D2 (2) | #FFB23F |

## Nets (everything on one line is electrically connected)

- btnFeed.1a · uno.D5 (~5)
- btnFeed.2a · uno.GND.2 (GND) · wifi1.GND
- btnPlay.1a · uno.D6 (~6)
- btnPlay.2a · rdiv2.2 · uno.GND.3 (GND)
- btnTalk.1a · uno.D4 (4)
- btnTalk.2a · buzzer1.NEG (−) · tft1.GND · uno.GND.1 (GND)
- buzzer1.POS (+) · uno.D7 (7)
- rdiv1.1 · uno.D3 (~3)
- rdiv1.2 · rdiv2.1 · wifi1.RX
- rtx.1 · wifi1.TX
- rtx.2 · uno.D2 (2)
- tft1.CS · uno.D10 (~10)
- tft1.DC (DC/RS) · uno.D9 (~9)
- tft1.LED · tft1.VCC · uno.5V
- tft1.MISO (SDO(MISO)) · uno.D12 (12)
- tft1.MOSI (SDI(MOSI)) · uno.D11 (~11)
- tft1.RST (RESET) · uno.D8 (8)
- tft1.SCK · uno.D13 (13)
- uno.3V3 (3.3V) · wifi1.VCC (3V3)
