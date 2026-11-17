// 16x2 I2C LCD (PCF8574 backpack at 0x27) with LiquidCrystal_PCF8574.
// Uno: SDA = A4, SCL = A5, VCC = 5V. Shows a title, a custom heart and seconds since start.
#include <Wire.h>
#include <LiquidCrystal_PCF8574.h>

LiquidCrystal_PCF8574 lcd(0x27);

byte heart[8] = {0b00000, 0b01010, 0b11111, 0b11111, 0b01110, 0b00100, 0b00000, 0b00000};

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x27);
  if (Wire.endTransmission() != 0) {
    Serial.println(F("LCD not found at 0x27: check wiring and address"));
    for (;;) {}
  }
  lcd.begin(16, 2);
  lcd.setBacklight(255);
  lcd.createChar(0, heart);
  lcd.home();
  lcd.clear();
  lcd.print(F("Hi, Fabwright "));
  lcd.write(byte(0));
  Serial.println(F("LCD ready"));
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print(F("t="));
  lcd.print(millis() / 1000);
  lcd.print(F("s"));
  delay(500);
}
