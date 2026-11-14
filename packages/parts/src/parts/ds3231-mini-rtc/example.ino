// DS3231 RTC with RTClib (Uno: SDA = A4, SCL = A5, VCC = 5V; on an ESP32 or XIAO use 3V3 and its SDA / SCL).
// If the clock lost power it is set to 2030-05-04 03:02:01. Prints the time and temperature
// every second.
#include <Wire.h>
#include <RTClib.h>

RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  if (!rtc.begin()) {
    Serial.println(F("DS3231 not found at 0x68: check wiring"));
    for (;;) {}
  }
  if (rtc.lostPower()) {
    Serial.println(F("RTC lost power, setting the time"));
    rtc.adjust(DateTime(2030, 5, 4, 3, 2, 1));
  }
}

void loop() {
  DateTime now = rtc.now();
  char buf[] = "YYYY-MM-DD hh:mm:ss";
  Serial.print(now.toString(buf));
  Serial.print(F(" "));
  Serial.print(rtc.getTemperature());
  Serial.println(F("C"));
  delay(1000);
}
