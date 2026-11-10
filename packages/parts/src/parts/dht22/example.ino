// DHT22 / AM2302 on D2, read without a library (the protocol is short).
// Wiring: + → 5V (or 3V3), OUT → D2, − → GND. The module has its own 10 kΩ pull-up.
const int DHT_PIN = 2;

// Wait while DATA stays at `level`; return the µs waited, or -1 after `timeout` µs.
static long waitWhile(int level, unsigned long timeout) {
  unsigned long start = micros();
  while (digitalRead(DHT_PIN) == level) {
    if (micros() - start > timeout) return -1;
  }
  return (long)(micros() - start);
}

// Returns false on a timeout or a bad checksum.
bool readDht22(float &tempC, float &humidity) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  pinMode(DHT_PIN, OUTPUT);
  digitalWrite(DHT_PIN, LOW);
  delay(2);                         // start signal: at least 1 ms LOW
  pinMode(DHT_PIN, INPUT_PULLUP);   // release; the sensor answers 20-40 µs later
  if (waitWhile(HIGH, 200) < 0) return false;
  if (waitWhile(LOW, 120) < 0) return false;   // 80 µs LOW
  if (waitWhile(HIGH, 120) < 0) return false;  // 80 µs HIGH
  for (int i = 0; i < 40; i++) {
    if (waitWhile(LOW, 100) < 0) return false;   // 50 µs LOW before every bit
    long high = waitWhile(HIGH, 120);            // 26 µs = 0, 70 µs = 1
    if (high < 0) return false;
    d[i / 8] = (d[i / 8] << 1) | (high > 45 ? 1 : 0);
  }
  if ((uint8_t)(d[0] + d[1] + d[2] + d[3]) != d[4]) return false;
  humidity = ((d[0] << 8) | d[1]) / 10.0;
  int t = ((d[2] & 0x7F) << 8) | d[3];
  tempC = (d[2] & 0x80 ? -t : t) / 10.0;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1500);  // the sensor needs 1 s after power-up
}

void loop() {
  float t, h;
  if (readDht22(t, h)) {
    Serial.print("T=");
    Serial.print(t, 1);
    Serial.print(" H=");
    Serial.println(h, 1);
  } else {
    Serial.println("DHT read failed");
  }
  delay(2000);  // at most one reading every 2 s
}
