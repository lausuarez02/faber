// Fixture for the qemu-esp backend test: Blink on LED_PIN (500 ms), Serial hello, and GPIO4 mirrored to GPIO2.
#ifndef LED_PIN
#define LED_PIN 8
#endif
#define IN_PIN 4
#define MIRROR_PIN 2
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(MIRROR_PIN, OUTPUT);
  pinMode(IN_PIN, INPUT);
  Serial.println("hello from fabwright esp32");
}
void loop() {
  static uint32_t next = 0;
  static bool on = false;
  static int last = -1;
  int v = digitalRead(IN_PIN);
  if (v != last) {
    digitalWrite(MIRROR_PIN, v);
    Serial.printf("in%d=%d\n", IN_PIN, v);
    last = v;
  }
  if (millis() >= next) {
    on = !on;
    digitalWrite(LED_PIN, on);
    next += 500;
  }
  delay(1);
}
