// Blinks the on-board LED and says "ready" on USB serial.
void setup() {
  Serial.begin(115200);
  // Serial is the board's own USB port: wait (up to 2 s) for the computer to open it, or the first
  // lines are lost.
  while (!Serial && millis() < 2000) delay(10);
  Serial.println("ready");
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, LOW);  // on (this LED is active low)
  delay(500);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
}
