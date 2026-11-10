// libs3 check: every pinned display / sensor library also builds for RP2040 (Seeed XIAO RP2040).
// Compile-only: the objects are created so the linker keeps each library's code.
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_ST7735.h>
#include <Adafruit_ST7789.h>
#include <Adafruit_ILI9341.h>
#include <Adafruit_GC9A01A.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_MPU6050.h>
#include <DHT.h>

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_ST7735 st7735(1, 29, 28);
Adafruit_ST7789 st7789(1, 29, 28);
Adafruit_ILI9341 ili(1, 29, 28);
Adafruit_GC9A01A roundTft(1, 29, 28);
Adafruit_MPU6050 mpu;
DHT dht(26, DHT22);

void setup() {
  Serial.begin(115200);
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  st7735.initR(INITR_BLACKTAB);
  st7789.init(240, 240);
  ili.begin();
  roundTft.begin();
  mpu.begin();
  dht.begin();
  Serial.println("all libraries linked");
}

void loop() {}
