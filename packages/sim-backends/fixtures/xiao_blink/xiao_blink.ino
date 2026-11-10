// Blink on a Seeed XIAO RP2040: D0 (GP26) drives an LED through 220 ohm, 500 ms on / 500 ms off,
// the on-board user LED (GP17, active low) follows it, and USB serial says what happened.
void setup() {
  Serial.begin(115200);
  pinMode(D0, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
}

unsigned long n = 0;

void loop() {
  digitalWrite(D0, HIGH);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.print("LED on ");
  Serial.println(n);
  delay(500);
  digitalWrite(D0, LOW);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.print("LED off ");
  Serial.println(millis());
  n++;
  delay(500);
}
