// The same OLED driven by U8g2 (full frame buffer, hardware I2C). Draws a frame and a filled
// box at the top-left, then toggles inverse video every 500 ms.
#include <Wire.h>
#include <U8g2lib.h>

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  u8g2.clearBuffer();
  u8g2.drawFrame(0, 0, 128, 64);
  u8g2.drawBox(4, 4, 20, 10);
  u8g2.sendBuffer();
  Serial.println(F("u8g2 ready"));
}

void loop() {
  delay(500);
  u8g2.sendF("c", 0xA7);  // inverse
  Serial.println(F("inverse"));
  delay(500);
  u8g2.sendF("c", 0xA6);  // normal
  Serial.println(F("normal"));
}
