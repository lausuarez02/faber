// I/O probe for a Seeed XIAO RP2040, one peripheral per pin:
//   D0 (GP26) button to GND, INPUT_PULLUP     D1 (GP27) PWM 25 % (analogWrite 64 of 255)
//   D2 (GP28) analog input, 10-bit            D3 (GP29) SPI chip select
//   D6 (GP0) Serial1 TX, D7 (GP1) Serial1 RX  D8/D9/D10 SPI SCK/MISO/MOSI
// Every 100 ms it prints the button, the ADC reading, sends "AT" on Serial1 (115200 baud, e.g. to an
// ESP-01) and does one SPI transfer (9F 00 00); lines received on Serial1 are echoed on USB serial
// as "rx <text>".
#include <SPI.h>

int n = 0;
String rx;

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);
  pinMode(D0, INPUT_PULLUP);
  pinMode(D3, OUTPUT);
  digitalWrite(D3, HIGH);
  analogWrite(D1, 64);
  SPI.begin();
}

void loop() {
  int adc = analogRead(A2);
  Serial.print("btn ");
  Serial.print(digitalRead(D0));
  Serial.print(" adc ");
  Serial.println(adc);

  Serial1.println("AT");

  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(D3, LOW);
  uint8_t a = SPI.transfer(0x9F);
  uint8_t b = SPI.transfer(0x00);
  uint8_t c = SPI.transfer(0x00);
  digitalWrite(D3, HIGH);
  SPI.endTransaction();
  Serial.print("spi ");
  Serial.print(a, HEX);
  Serial.print(" ");
  Serial.print(b, HEX);
  Serial.print(" ");
  Serial.println(c, HEX);

  unsigned long until = millis() + 100;
  while ((long)(millis() - until) < 0) {
    while (Serial1.available()) {
      char ch = (char)Serial1.read();
      if (ch == '\n') {
        Serial.print("rx ");
        Serial.println(rx);
        rx = "";
      } else if (ch != '\r') {
        rx += ch;
      }
    }
  }
  n++;
}
