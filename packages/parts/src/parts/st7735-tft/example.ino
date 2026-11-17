// ST7735 1.8in 128x160 colour TFT (black tab) with Adafruit_ST7735 (Uno: CS = D10, A0/DC = D9,
// RESET = D8, SDA/MOSI = D11, SCK = D13, VCC = 5V, LED = 5V).
// Portrait: a red block top-left, a green block top-right, a blue circle and text; then counts.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

Adafruit_ST7735 tft(10, 9, 8);  // CS, DC, RST (hardware SPI)

void setup() {
  Serial.begin(115200);
  tft.initR(INITR_BLACKTAB);
  tft.fillScreen(ST77XX_BLACK);
  tft.fillRect(0, 0, 32, 24, ST77XX_RED);
  tft.fillRect(96, 0, 32, 24, ST77XX_GREEN);
  tft.fillCircle(64, 100, 20, ST77XX_BLUE);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(4, 40);
  tft.print(F("Fabwright"));
  Serial.println(F("ST7735 drawn"));
}

unsigned int count = 0;

void loop() {
  tft.fillRect(4, 136, 80, 16, ST77XX_BLACK);
  tft.setCursor(4, 136);
  tft.print(count);
  Serial.print(F("count "));
  Serial.println(count++);
  delay(200);
}
