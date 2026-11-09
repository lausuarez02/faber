// WS2812B strip on D6, sent without a library (16 MHz AVR: Uno / Nano).
// Wiring: 5V → 5V, GND → GND, DIN → D6 (330 Ω in series is good practice).
// Each LED takes 3 bytes in G, R, B order; a 0 bit is a ~0.3 µs HIGH pulse, a 1 bit ~0.75 µs.
const int NUM_LEDS = 8;
uint8_t grb[NUM_LEDS * 3];

void setColor(int i, uint8_t r, uint8_t g, uint8_t b) {
  grb[i * 3] = g;
  grb[i * 3 + 1] = r;
  grb[i * 3 + 2] = b;
}

void show() {
  uint8_t hi = PORTD | _BV(6);  // D6 is PORTD bit 6
  uint8_t lo = PORTD & ~_BV(6);
  noInterrupts();
  for (uint16_t i = 0; i < sizeof(grb); i++) {
    uint8_t v = grb[i];
    for (uint8_t bit = 0; bit < 8; bit++) {
      if (v & 0x80) {
        PORTD = hi; __builtin_avr_delay_cycles(11); PORTD = lo;  // 1: 12 cycles = 0.75 µs HIGH
      } else {
        PORTD = hi; __builtin_avr_delay_cycles(4); PORTD = lo;   // 0: 5 cycles = 0.31 µs HIGH
        __builtin_avr_delay_cycles(4);
      }
      v <<= 1;
    }
  }
  interrupts();
  delayMicroseconds(80);  // LOW for > 50 µs latches the colours
}

void setup() {
  pinMode(6, OUTPUT);
  Serial.begin(115200);
  setColor(0, 255, 0, 0);    // red
  setColor(1, 0, 255, 0);    // green
  setColor(2, 0, 0, 255);    // blue
  setColor(3, 255, 255, 255);
  setColor(4, 16, 8, 0);     // dim orange
  show();
  Serial.println("frame 1");
  delay(100);
  for (int i = 0; i < NUM_LEDS; i++) setColor(i, 0, 0, 40);
  show();
  Serial.println("frame 2");
}

void loop() {}
