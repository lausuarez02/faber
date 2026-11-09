// SSD1306 128x64 I2C OLED on a Seeed XIAO RP2040 (SDA = D4/GP6, SCL = D5/GP7, Wire on I2C1).
// Draws a title and a counter that changes every 250 ms; float math exercises the ROM float routines.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int frame = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("oled fail");
    for (;;) delay(100);
  }
  Serial.println("oled ok");
}

void loop() {
  float t = frame * 0.25f;
  float s = sinf(t) * 20.0f;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Pocket");
  display.setTextSize(1);
  display.print("frame ");
  display.println(frame);
  display.fillRect(0, 40, 64 + (int)s, 8, SSD1306_WHITE);
  display.display();
  Serial.print("frame ");
  Serial.print(frame);
  Serial.print(" bar ");
  Serial.println(64 + (int)s);
  frame++;
  delay(250);
}
