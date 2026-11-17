// ILI9341 2.8in 320x240 colour TFT on SPI with Adafruit_ILI9341 (Uno: CS = D10, DC = D9,
// RST = D8, MOSI = D11, SCK = D13, MISO = D12, VCC = 5V, LED = 5V).
// Draws colour blocks, a circle and text in landscape, reads two registers back, then counts.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

Adafruit_ILI9341 tft(10, 9, 8);  // CS, DC, RST (hardware SPI)

void setup() {
  Serial.begin(115200);
  tft.begin();
  Serial.print(F("RDMODE 0x"));
  Serial.println(tft.readcommand8(ILI9341_RDMODE), HEX);
  Serial.print(F("RDPIXFMT 0x"));
  Serial.println(tft.readcommand8(ILI9341_RDPIXFMT), HEX);
  tft.setRotation(1);  // landscape, 320 x 240
  tft.fillScreen(ILI9341_BLACK);
  tft.fillRect(0, 0, 40, 30, ILI9341_RED);
  tft.fillRect(40, 0, 40, 30, ILI9341_GREEN);
  tft.fillRect(80, 0, 40, 30, ILI9341_BLUE);
  tft.fillCircle(240, 150, 40, ILI9341_YELLOW);
  tft.drawFastHLine(0, 239, 320, ILI9341_WHITE);
  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(3);
  tft.setCursor(10, 100);
  tft.print(F("Fabwright"));
  Serial.println(F("ILI9341 drawn"));
}

unsigned int count = 0;

void loop() {
  tft.fillRect(10, 200, 120, 24, ILI9341_NAVY);
  tft.setTextSize(3);
  tft.setTextColor(ILI9341_CYAN);
  tft.setCursor(10, 200);
  tft.print(count);
  Serial.print(F("count "));
  Serial.println(count);
  count++;
  delay(200);
}
