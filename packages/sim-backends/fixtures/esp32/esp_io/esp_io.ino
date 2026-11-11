// Jumper golden fixture (ESP32 family): GPIO interrupts, LEDC PWM (analogWrite, a 50 Hz servo
// pulse, tone()) and the ADC. Prints one status line every 100 ms of virtual time.
#include "esp_pins.h"

volatile uint32_t rises = 0;
volatile uint32_t falls = 0;
void IRAM_ATTR onRise() { rises++; }

void setup() {
  Serial.begin(115200);
  pinMode(PIN_IRQ, INPUT);
  attachInterrupt(PIN_IRQ, onRise, RISING);
  analogWrite(PIN_LED, 64);              // LEDC, 1 kHz, 8 bit: 25 %
  ledcAttach(PIN_SERVO, 50, 14);         // servo frame (14 bit: the most the S3 / C3 LEDC has)
  ledcWrite(PIN_SERVO, 1229);            // 1.5 ms of 20 ms
  tone(PIN_TONE, 2000);
  analogReadResolution(12);
  Serial.println("io ready");
}

uint32_t last = 0;
int phase = 0;
void loop() {
  uint32_t now = millis();
  if (now - last < 100) return;
  last = now;
  int a = analogRead(PIN_ADC_A);
  int mv = analogReadMilliVolts(PIN_ADC_A);
  int b = analogRead(PIN_ADC_B);
  Serial.printf("t=%lu irq=%lu adc=%d mv=%d adcb=%d\n", (unsigned long)now, (unsigned long)rises, a, mv, b);
  phase++;
  if (phase == 3) {
    analogWrite(PIN_LED, 192);           // 75 %
    ledcWrite(PIN_SERVO, 1638);          // 2.0 ms
    noTone(PIN_TONE);
    Serial.println("changed");
  }
  if (phase == 5) {
    ledcFade(PIN_LED, 192, 0, 200);      // hardware fade to 0 over 200 ms
    Serial.println("fading");
  }
}
