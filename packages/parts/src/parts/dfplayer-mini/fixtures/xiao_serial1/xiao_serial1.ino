// DFPlayer Mini on the XIAO RP2040's Serial1 (D6 = GP0 TX -> 1k -> RX, D7 = GP1 RX <- TX). Plays
// track 2, waits for the "track finished" reply (0x3D), then plays track 1, and reports on USB
// serial. Test fixture for the rp2040 UART on pins (round 7, voice).
void dfSend(uint8_t cmd, uint16_t param) {
  uint8_t f[10] = {0x7E, 0xFF, 0x06, cmd, 0x00, (uint8_t)(param >> 8), (uint8_t)(param & 0xFF), 0, 0, 0xEF};
  uint16_t sum = 0;
  for (int i = 1; i < 7; i++) sum += f[i];
  uint16_t chk = (uint16_t)(0 - sum);
  f[7] = chk >> 8;
  f[8] = chk & 0xFF;
  Serial1.write(f, 10);
}

uint8_t rx[10];
int n = 0;
bool second = false;

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  delay(1500);
  while (Serial1.available()) {
    if (Serial1.read() == 0x3F) Serial.println("player online");
  }
  dfSend(0x06, 25);
  delay(20);
  dfSend(0x03, 2);
  Serial.println("say 2");
}

void loop() {
  while (Serial1.available()) {
    uint8_t b = Serial1.read();
    if (n == 0 && b != 0x7E) continue;
    rx[n++] = b;
    if (n == 10) {
      n = 0;
      if (rx[3] == 0x3D && !second) {
        Serial.print("done ");
        Serial.println(rx[6]);
        second = true;
        dfSend(0x03, 1);
        Serial.println("say 1");
      }
    }
  }
}
