// libs3 check: TFT_eSPI (Bodmer) drawing on a GC9A01 round TFT from a Seeed XIAO RP2040.
// The display and pins are in tft_setup.h next to this sketch.
#include <TFT_eSPI.h>

TFT_eSPI tft;

void setup() {
  Serial.begin(115200);
  tft.init();
  tft.fillScreen(TFT_BLACK);
  tft.fillCircle(120, 120, 90, TFT_ORANGE);
  tft.fillCircle(90, 100, 14, TFT_BLACK);
  tft.fillCircle(150, 100, 14, TFT_BLACK);
  tft.fillRect(85, 150, 70, 10, TFT_BLUE);
  Serial.println("tft_espi drawn");
}

void loop() {}
