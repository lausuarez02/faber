// SPI probe: selects the device on D10, sends 0x9F 0x00 0x00 (a JEDEC-ID style read) and
// prints the three bytes it got back, every 20 ms. Golden fixture for the AVR SPI tests.
#include <SPI.h>

const byte CS = 10;

void setup() {
  Serial.begin(115200);
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  SPI.begin();
}

void loop() {
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CS, LOW);
  byte a = SPI.transfer(0x9F);
  byte b = SPI.transfer(0x00);
  byte c = SPI.transfer(0x00);
  digitalWrite(CS, HIGH);
  SPI.endTransaction();
  Serial.print("spi ");
  Serial.print(a, HEX);
  Serial.print(' ');
  Serial.print(b, HEX);
  Serial.print(' ');
  Serial.println(c, HEX);
  delay(20);
}
