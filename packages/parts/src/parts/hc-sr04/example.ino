// HC-SR04 example: print the distance every 100 ms.
// Wiring: VCC -> 5V, GND -> GND, TRIG -> D9, ECHO -> D10.
const int TRIG = 9;
const int ECHO = 10;

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);      // a 10 us pulse starts one measurement
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 30000UL);  // 0 = no echo within 30 ms
  if (us == 0) {
    Serial.println("out of range");
  } else {
    Serial.print(us / 58);       // 58 us per cm, there and back
    Serial.println(" cm");
  }
  delay(100);
}
