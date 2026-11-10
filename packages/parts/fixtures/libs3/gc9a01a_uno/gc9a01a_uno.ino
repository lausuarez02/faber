// libs3 check: Adafruit_GC9A01A on an Uno (hardware SPI). Wiring: SCL → D13, SDA → D11, RES → D8,
// DC → D9, CS → D10, VCC → 5V, GND → GND. Draws an orange disc and two dark eyes, then says so.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>

Adafruit_GC9A01A tft(10, 9, 8);

void setup() {
  Serial.begin(115200);
  tft.begin();
  tft.fillScreen(GC9A01A_BLACK);
  tft.fillCircle(120, 120, 90, GC9A01A_ORANGE);
  tft.fillCircle(90, 100, 14, GC9A01A_BLACK);
  tft.fillCircle(150, 100, 14, GC9A01A_BLACK);
  tft.fillRect(85, 150, 70, 10, GC9A01A_BLUE);
  Serial.println("gc9a01a drawn");
}

void loop() {}
