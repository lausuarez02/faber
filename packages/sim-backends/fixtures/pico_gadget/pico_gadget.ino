// Pocket gadget on a Raspberry Pi Pico, one part per bus:
//   ST7735 colour TFT on SPI0 (SCK GP18, MOSI GP19, CS GP17, DC GP20, RST GP21)
//   MPU6050 on Wire (SDA GP4, SCL GP5)
//   button on GP14 to GND (INPUT_PULLUP), passive buzzer on GP15 (tone 1 kHz while pressed)
// The screen shows the accelerometer's X/Y/Z in g; serial prints the same values.
#include <SPI.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

Adafruit_ST7735 tft(17, 20, 21);  // CS, DC, RST on the default SPI0 pins
Adafruit_MPU6050 mpu;
bool beeping = false;

void setup() {
  Serial.begin(115200);
  pinMode(14, INPUT_PULLUP);
  tft.initR(INITR_BLACKTAB);
  tft.fillScreen(ST77XX_BLACK);
  tft.fillRect(0, 0, 128, 20, ST77XX_BLUE);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(1);
  tft.setCursor(4, 6);
  tft.print("Pico gadget");
  if (!mpu.begin()) {
    Serial.println("mpu fail");
  } else {
    Serial.println("mpu ok");
  }
}

void loop() {
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  float x = a.acceleration.x / 9.81f, y = a.acceleration.y / 9.81f, z = a.acceleration.z / 9.81f;
  tft.fillRect(0, 30, 128, 40, ST77XX_BLACK);
  tft.setTextSize(2);
  tft.setCursor(4, 30);
  tft.print("z ");
  tft.print(z, 2);
  Serial.print("accel ");
  Serial.print(x, 2);
  Serial.print(" ");
  Serial.print(y, 2);
  Serial.print(" ");
  Serial.println(z, 2);

  bool pressed = digitalRead(14) == LOW;
  if (pressed && !beeping) {
    tone(15, 1000);
    Serial.println("beep");
  } else if (!pressed && beeping) {
    noTone(15);
  }
  beeping = pressed;
  delay(100);
}
