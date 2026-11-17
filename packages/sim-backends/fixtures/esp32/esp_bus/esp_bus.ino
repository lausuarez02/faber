// Fabwright golden fixture (ESP32 family): I2C (Wire, and Wire1 where the chip has two controllers),
// SPI (the default bus, CS by GPIO), and UART1 / UART2 on GPIO-matrix pins.
#include <Wire.h>
#include <SPI.h>
#include "esp_pins.h"

static void scan(TwoWire &w, const char *name) {
  Serial.printf("%s scan:", name);
  for (uint8_t a = 1; a < 127; a++) {
    w.beginTransmission(a);
    if (w.endTransmission() == 0) Serial.printf(" %02x", a);
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  scan(Wire, "i2c0");
  Wire.beginTransmission(0x3c);
  Wire.write(0x04);
  Wire.write(0xaa);
  Serial.printf("write 0x3c -> %d\n", Wire.endTransmission());
  Wire.beginTransmission(0x3c);
  Wire.write(0x02);
  Wire.endTransmission(false);           // repeated START
  int n = Wire.requestFrom(0x3c, 4);
  Serial.printf("read 0x3c n=%d:", n);
  while (Wire.available()) Serial.printf(" %02x", Wire.read());
  Serial.println();
#if HAS_WIRE1
  Wire1.begin(PIN_SDA1, PIN_SCL1);
  scan(Wire1, "i2c1");
  Wire1.beginTransmission(0x48);
  Wire1.write(0x00);
  Wire1.endTransmission(false);
  n = Wire1.requestFrom(0x48, 2);
  Serial.printf("i2c1 0x48 n=%d:", n);
  while (Wire1.available()) Serial.printf(" %02x", Wire1.read());
  Serial.println();
#endif
  SPI.begin();
  pinMode(SS, OUTPUT);
  digitalWrite(SS, HIGH);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(SS, LOW);
  uint8_t r0 = SPI.transfer(0x9f);
  uint8_t r1 = SPI.transfer(0x00);
  uint8_t r2 = SPI.transfer(0x00);
  digitalWrite(SS, HIGH);
  uint8_t buf[100];
  for (int i = 0; i < 100; i++) buf[i] = i;
  digitalWrite(SS, LOW);
  SPI.writeBytes(buf, sizeof(buf));
  digitalWrite(SS, HIGH);
  SPI.endTransaction();
  Serial.printf("spi %02x %02x %02x\n", r0, r1, r2);
  Serial1.begin(9600, SERIAL_8N1, PIN_U1_RX, PIN_U1_TX);
  Serial1.print("AT\r\n");
#if HAS_SERIAL2
  Serial2.begin(115200, SERIAL_8N1, PIN_U2_RX, PIN_U2_TX);
  Serial2.print("U2\r\n");
#endif
  Serial.println("bus ready");
}

String line1, line2;
void loop() {
  while (Serial1.available()) {
    char c = Serial1.read();
    if (c == '\n') { Serial.printf("rx1 %s\n", line1.c_str()); line1 = ""; }
    else if (c != '\r') line1 += c;
  }
#if HAS_SERIAL2
  while (Serial2.available()) {
    char c = Serial2.read();
    if (c == '\n') { Serial.printf("rx2 %s\n", line2.c_str()); line2 = ""; }
    else if (c != '\r') line2 += c;
  }
#endif
}
