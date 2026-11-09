#pragma once
#include <Arduino.h>

enum Mood { HAPPY, OK, HUNGRY, SAD, TIRED, SLEEPING };

struct Button {
  uint8_t pin;
  bool last;  // last stable level (true = released)
  unsigned long changedAt;
};
