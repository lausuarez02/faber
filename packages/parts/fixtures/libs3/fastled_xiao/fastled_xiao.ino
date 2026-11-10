// libs3 check (Seeed XIAO RP2040): FastLED driving an 8-LED WS2812B strip on GP26 (XIAO D0): red, green, blue, then a dim white rest.
#include <FastLED.h>

#define DATA_PIN 26
#define NUM_LEDS 8
CRGB leds[NUM_LEDS];

void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS);
  leds[0] = CRGB(255, 0, 0);
  leds[1] = CRGB(0, 255, 0);
  leds[2] = CRGB(0, 0, 255);
  for (int i = 3; i < NUM_LEDS; i++) leds[i] = CRGB(16, 16, 16);
  FastLED.show();
  Serial.println("fastled shown");
}

void loop() {}
