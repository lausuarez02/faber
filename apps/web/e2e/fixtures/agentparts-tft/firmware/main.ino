#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>
// ST7789 240x240 face on an agent-made round display: CS D10, DC D9, RST D8.
Adafruit_ST7789 tft(10, 9, 8);
void setup() {
  Serial.begin(115200);
  tft.init(240, 240);
  tft.fillScreen(ST77XX_BLACK);
  tft.fillCircle(120, 120, 100, ST77XX_YELLOW);
  tft.fillCircle(85, 95, 14, ST77XX_BLACK);
  tft.fillCircle(155, 95, 14, ST77XX_BLACK);
  tft.fillRect(80, 150, 80, 12, ST77XX_BLACK);
  Serial.println("face drawn");
}
void loop() {}
