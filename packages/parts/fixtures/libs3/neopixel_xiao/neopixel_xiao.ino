// libs3 check: Adafruit NeoPixel (LGPL-3.0, compiled into this firmware only) driving an 8-LED
// WS2812B strip on GP26 (XIAO D0) of a Seeed XIAO RP2040: red, green, blue, then a dim white rest.
#include <Adafruit_NeoPixel.h>

#define DATA_PIN 26
#define NUM_LEDS 8
Adafruit_NeoPixel strip(NUM_LEDS, DATA_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  strip.begin();
  strip.setPixelColor(0, strip.Color(255, 0, 0));
  strip.setPixelColor(1, strip.Color(0, 255, 0));
  strip.setPixelColor(2, strip.Color(0, 0, 255));
  for (int i = 3; i < NUM_LEDS; i++) strip.setPixelColor(i, strip.Color(16, 16, 16));
  strip.show();
  Serial.println("neopixel shown");
}

void loop() {}
