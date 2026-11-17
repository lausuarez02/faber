// Faber golden fixture (ESP32 family): 8 WS2812 LEDs through the RMT (Adafruit NeoPixel).
#include <Adafruit_NeoPixel.h>
#include "esp_pins.h"

Adafruit_NeoPixel strip(8, PIN_NEO, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  strip.begin();
  strip.setPixelColor(0, strip.Color(255, 0, 0));
  strip.setPixelColor(1, strip.Color(0, 255, 0));
  strip.setPixelColor(2, strip.Color(0, 0, 255));
  strip.setPixelColor(7, strip.Color(16, 32, 48));
  strip.show();
  Serial.println("shown 1");
}

int frame = 0;
void loop() {
  delay(50);
  frame++;
  if (frame == 2) {
    for (int i = 0; i < 8; i++) strip.setPixelColor(i, strip.Color(i * 10, 255 - i * 30, 7));
    strip.show();
    Serial.println("shown 2");
  }
}
