// Bridge test: PB0 button -> PC13 LED mirror, I2C read of a fake sensor at 0x48 (reg 0x00, 2 bytes), SPI loopback byte.
#include <Wire.h>
#include <SPI.h>
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(PB0, INPUT_PULLUP);
  Serial.begin(115200);
  Wire.begin();
  SPI.begin();
  pinMode(PA4, OUTPUT); digitalWrite(PA4, HIGH);
  Serial.println("bridge up");
}
int n = 0;
void loop() {
  int btn = digitalRead(PB0);
  digitalWrite(LED_BUILTIN, btn);
  Wire.beginTransmission(0x48); Wire.write(0x00); int e = Wire.endTransmission(false);
  int got = Wire.requestFrom(0x48, 2);
  int hi = Wire.read(), lo = Wire.read();
  digitalWrite(PA4, LOW);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  int s = SPI.transfer(0x9F);
  SPI.endTransaction();
  digitalWrite(PA4, HIGH);
  Serial.print("n="); Serial.print(n++); Serial.print(" ms="); Serial.print(millis());
  Serial.print(" btn="); Serial.print(btn); Serial.print(" i2c_err="); Serial.print(e);
  Serial.print(" got="); Serial.print(got); Serial.print(" raw=0x"); Serial.print((hi << 8) | lo, HEX);
  Serial.print(" spi=0x"); Serial.println(s, HEX);
  delay(50);
}
