// e2e fixture: a Black Pill F411 drawing on an SSD1306 128x64 over Wire (PB7 SDA / PB6 SCL).
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
int frame = 0;
void setup() {
  Serial.begin(115200);
  pinMode(PC13, OUTPUT);
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("oled missing");
  else Serial.println("oled ok");
}
void loop() {
  oled.clearDisplay();
  oled.setTextSize(2);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.println("Black Pill");
  oled.setTextSize(1);
  oled.print("frame ");
  oled.println(frame);
  oled.fillRect(0, 48, (frame * 8) % 128, 12, SSD1306_WHITE);
  oled.display();
  digitalWrite(PC13, frame & 1);
  Serial.print("frame ");
  Serial.println(frame++);
  delay(100);
}
