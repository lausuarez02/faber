// libs3 check: Adafruit_GC9A01A on a Seeed XIAO RP2040 (SPI0). Wiring: SCL → GP2, SDA → GP3, RES → GP28,
// DC → GP29, CS → GP1, VCC → 3V3, GND → GND. Draws an orange disc and two dark eyes, then says so.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>

Adafruit_GC9A01A tft(1, 29, 28);

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
