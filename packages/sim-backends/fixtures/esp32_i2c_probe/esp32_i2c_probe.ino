// Fixture for the qemu-esp backend I2C test (ESP32 only: the S3/C3 machines model no I2C controller).
// Scans, reads the QEMU-internal tmp105 at 0x48, then writes and reads a part living in Faber at 0x3c.
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22, 100000);
  Serial.print("scan:");
  for (uint8_t a = 1; a < 127; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) Serial.printf(" %02x", a); }
  Serial.println();
  Wire.beginTransmission(0x48); Wire.write(0); Wire.endTransmission(false);
  Wire.requestFrom(0x48, 2); int hi = Wire.read(), lo = Wire.read();
  Serial.printf("tmp105 raw %02x %02x = %.2f C\n", hi, lo, ((int16_t)((hi << 8) | lo) >> 4) * 0.0625);
  Wire.beginTransmission(0x3c); Wire.write(0x04); Wire.write(0xAA); int e = Wire.endTransmission();
  Serial.printf("write 0x3c -> %d\n", e);
  Wire.beginTransmission(0x3c); Wire.write(0x02); Wire.endTransmission(false);
  int n = Wire.requestFrom(0x3c, 4);
  Serial.printf("read 0x3c n=%d:", n); while (Wire.available()) Serial.printf(" %02x", Wire.read()); Serial.println();
}
void loop() { delay(1000); }
