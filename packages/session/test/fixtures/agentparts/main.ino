#include <Wire.h>
#include <SoftwareSerial.h>
// Test sketch for agent-made parts (packages/session/test/agentparts.test.ts):
// I2C sensor at 0x40, soil sensor on A0, relay IN on D7 (active LOW), PIR OUT on D4,
// a UART module on SoftwareSerial D2 (RX) / D3 (TX) at 9600 baud.
SoftwareSerial mod(2, 3);
void setup() {
  Serial.begin(115200);
  mod.begin(9600);
  Wire.begin();
  pinMode(7, OUTPUT);
  digitalWrite(7, HIGH);
  pinMode(4, INPUT);
  Wire.beginTransmission(0x40); Wire.write(0x10); Wire.write(0x03); Wire.endTransmission();
}
void loop() {
  Wire.beginTransmission(0x40); Wire.write(0x0F); byte e = Wire.endTransmission(false);
  Wire.requestFrom(0x40, 1); int who = Wire.available() ? Wire.read() : -1;
  Wire.beginTransmission(0x40); Wire.write(0x00); Wire.endTransmission(false);
  Wire.requestFrom(0x40, 2); int16_t raw = 0; if (Wire.available() >= 2) { raw = Wire.read() << 8; raw |= Wire.read(); }
  int a = analogRead(A0);
  bool dry = a > 500;
  digitalWrite(7, dry ? LOW : HIGH);
  mod.print("PING\r\n");
  String reply = "";
  unsigned long t0 = millis();
  while (millis() - t0 < 60) {
    while (mod.available()) { char c = mod.read(); if (c == '\n') { t0 = 0; break; } if (c != '\r') reply += c; }
    if (t0 == 0) break;
  }
  Serial.print("who=0x"); Serial.print(who, HEX); Serial.print(" err="); Serial.print(e);
  Serial.print(" t="); Serial.print(raw / 100.0, 2); Serial.print(" a0="); Serial.print(a);
  Serial.print(dry ? " pump=on" : " pump=off");
  Serial.print(" pir="); Serial.print(digitalRead(4));
  Serial.print(" uart="); Serial.println(reply);
  delay(50);
}
