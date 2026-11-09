// SG90 example: sweep 0 -> 90 -> 180 degrees, one second each, and print the angle.
// Wiring: brown GND -> GND, red V+ -> 5V, orange signal -> D9.
//
// With the Servo library this is:  Servo s; s.attach(9); s.write(angle);
// Here the 50 Hz pulse comes straight from Timer1 (OC1A = D9), so no library is needed.
void writeAngle(int angle) {
  // 544 us = 0 deg, 2400 us = 180 deg; Timer1 counts 0.5 us ticks.
  OCR1A = map(constrain(angle, 0, 180), 0, 180, 544, 2400) * 2;
}

void setup() {
  pinMode(9, OUTPUT);
  TCCR1A = _BV(COM1A1) | _BV(WGM11);               // fast PWM, TOP = ICR1, clear OC1A on match
  TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS11);    // prescaler 8 -> 2 MHz
  ICR1 = 39999;                                     // 20 ms period
  Serial.begin(115200);
}

void loop() {
  const int angles[] = {0, 90, 180};
  for (int i = 0; i < 3; i++) {
    writeAngle(angles[i]);
    Serial.print("angle ");
    Serial.println(angles[i]);
    delay(1000);
  }
}
