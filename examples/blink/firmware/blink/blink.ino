// Jumper golden firmware: classic Blink on the built-in LED (D13), 1 s on / 1 s off,
// announcing every change on the serial port (115200 baud).
// SPDX-License-Identifier: Apache-2.0

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED on");
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED off");
  delay(1000);
}
