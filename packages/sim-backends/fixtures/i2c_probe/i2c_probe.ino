// I2C probe: the classic I2C scanner, then a write and a read to 0x3C every 20 ms, printing
// what Wire reports. Golden fixture for the AVR TWI tests (packages/sim-backends/src/twi.test.ts).
// Build: see packages/sim-backends/fixtures/BUILD.md
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  byte found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte err = Wire.endTransmission();
    if (err == 0) {
      Serial.print("found 0x");
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      found++;
    }
  }
  Serial.print("scan done ");
  Serial.println(found);
}

void loop() {
  Wire.beginTransmission(0x3C);
  Wire.write(0x00);   // control byte: command stream
  Wire.write(0xAF);   // SSD1306: display on
  byte err = Wire.endTransmission();
  Serial.print("tx ");
  Serial.print(err);
  byte n = Wire.requestFrom((uint8_t)0x3C, (uint8_t)1);
  Serial.print(" rx ");
  Serial.print(n);
  if (n) {
    Serial.print(' ');
    Serial.print(Wire.read(), HEX);
  }
  Serial.println();
  delay(20);
}
