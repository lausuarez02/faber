// Renode board fixture: proves every listed pin works as an output and as an input.
// Phase 1 (before the console starts): each pin in turn goes OUTPUT, HIGH for 2 ms, LOW, back to INPUT.
// Phase 2: prints "ready <n>", then every 10 ms "in <bits>" (one 0 / 1 per pin, in order) as read
// with digitalRead while the test drives the pins.
#include "pins.h"

void setup() {
  for (unsigned i = 0; i < NPINS; i++) {
    pinMode(PINS[i], OUTPUT);
    digitalWrite(PINS[i], HIGH);
    delay(2);
    digitalWrite(PINS[i], LOW);
    delay(1);
    pinMode(PINS[i], INPUT);
  }
  CONSOLE.begin(115200);
  CONSOLE.print("ready ");
  CONSOLE.println(NPINS);
}

void loop() {
  char bits[64];
  unsigned i = 0;
  for (; i < NPINS && i < sizeof(bits) - 1; i++) bits[i] = digitalRead(PINS[i]) ? '1' : '0';
  bits[i] = 0;
  CONSOLE.print("in ");
  CONSOLE.println(bits);
  delay(10);
}
