// The same 16x2 I2C LCD with the LiquidCrystal_I2C API (lcd.init(), lcd.backlight()), which most
// Arduino tutorials use. Fabwright's toolchain ships an Apache-2.0 implementation of that API.
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(115200);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello, world!");
  lcd.setCursor(3, 1);
  lcd.print("Fabwright LCD");
  Serial.println("LCD ready");
}

void loop() {}
