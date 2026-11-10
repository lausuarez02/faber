// libs3 check: the Adafruit DHT sensor library reading a DHT22 on GP26 (XIAO D0) of a Seeed XIAO RP2040.
#include <DHT.h>

#define DHT_PIN 26
DHT dht(DHT_PIN, DHT22);

void setup() {
  Serial.begin(115200);
  dht.begin();
}

void loop() {
  delay(2100);  // the DHT22 measures at most every 2 s
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("dht read failed");
    return;
  }
  Serial.print("t=");
  Serial.print(t, 1);
  Serial.print(" h=");
  Serial.println(h, 1);
}
