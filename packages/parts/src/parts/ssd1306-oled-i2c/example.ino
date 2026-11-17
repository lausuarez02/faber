// SSD1306 128x64 OLED on I2C with Adafruit_SSD1306 (Uno: SDA = A4, SCL = A5, VCC = 5V).
// Draws a frame, a title and a counter that updates every 250 ms. Prints the counter on Serial.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);  // -1: no reset pin

void setup() {
  Serial.begin(115200);
  // display.begin() does not notice a missing display, so probe the address first.
  Wire.begin();
  Wire.beginTransmission(0x3C);
  if (Wire.endTransmission() != 0 || !display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 not found at 0x3C: check wiring"));
    for (;;) {}
  }
  display.clearDisplay();
  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(16, 8);
  display.print(F("Faber"));
  display.display();
  Serial.println(F("SSD1306 ready"));
}

unsigned int count = 0;

void loop() {
  display.fillRect(16, 36, 96, 16, SSD1306_BLACK);
  display.setTextSize(2);
  display.setCursor(16, 36);
  display.print(count);
  display.display();
  Serial.print(F("count "));
  Serial.println(count);
  count++;
  delay(250);
}
