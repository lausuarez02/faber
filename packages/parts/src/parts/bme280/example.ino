// BME280 with Adafruit_BME280 (Uno: SDA = A4, SCL = A5, VIN = 5V). Most modules are at 0x76;
// the library's default (begin() with no argument) is 0x77.
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  if (!bme.begin(0x76)) {
    Serial.println(F("BME280 not found at 0x76: check wiring and address"));
    for (;;) {}
  }
}

void loop() {
  Serial.print(F("T="));
  Serial.print(bme.readTemperature(), 2);
  Serial.print(F(" P="));
  Serial.print(bme.readPressure() / 100.0F, 2);
  Serial.print(F(" H="));
  Serial.println(bme.readHumidity(), 2);
  delay(500);
}
