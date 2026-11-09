// Two-joint robot arm for Jumper (examples/robot-arm).
//
// Parts: Arduino Uno, two SG90 servos (shoulder on D9, elbow on D10), two 10 k potentiometers
// (shoulder on A0, elbow on A1). Turning a pot moves its joint: the servo angle follows the
// knob 0..180 degrees.
//
// Servo pulses come straight from Timer1 (hardware PWM on OC1A = D9 and OC1B = D10): 50 Hz,
// 544..2400 us, the same signal the Servo library makes. Using the timer directly keeps the
// sketch free of extra libraries. With the Servo library it would be:
//   Servo shoulder; shoulder.attach(9); shoulder.write(angle);

const uint16_t MIN_US = 544, MAX_US = 2400;

void setPulse(volatile uint16_t &ocr, int angle) {
  uint16_t us = map(constrain(angle, 0, 180), 0, 180, MIN_US, MAX_US);
  ocr = us * 2;  // Timer1 ticks at 2 MHz (16 MHz / 8): 2 ticks per microsecond
}

void setup() {
  pinMode(9, OUTPUT);
  pinMode(10, OUTPUT);
  // Fast PWM, TOP = ICR1 (mode 14), non-inverting on OC1A/OC1B, prescaler 8.
  TCCR1A = _BV(COM1A1) | _BV(COM1B1) | _BV(WGM11);
  TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS11);
  ICR1 = 39999;  // 40000 ticks of 0.5 us = 20 ms = 50 Hz
  setPulse(OCR1A, 90);
  setPulse(OCR1B, 90);
  Serial.begin(115200);
  Serial.println("arm ready");
}

unsigned long lastPrint = 0;

void loop() {
  int shoulder = map(analogRead(A0), 0, 1023, 0, 180);
  int elbow = map(analogRead(A1), 0, 1023, 0, 180);
  setPulse(OCR1A, shoulder);
  setPulse(OCR1B, elbow);
  if (millis() - lastPrint >= 250) {
    lastPrint = millis();
    Serial.print("shoulder ");
    Serial.print(shoulder);
    Serial.print(" elbow ");
    Serial.println(elbow);
  }
  delay(20);
}
