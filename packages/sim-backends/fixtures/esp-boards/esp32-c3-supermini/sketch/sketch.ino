// Fixture for esp32-c3-supermini (round 10): proves boot, GPIO out, GPIO in with the internal pull-up, and Serial.
// GPIO10 toggles every 100 ms; GPIO9 is INPUT_PULLUP and every change is printed.
const int OUT = 10;
const int IN = 9;
void setup() {
  Serial.begin(115200);
  pinMode(OUT, OUTPUT);
  pinMode(IN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("boot esp32-c3-supermini");
}
int last = -1;
unsigned long t = 0;
bool on = false;
void loop() {
  if (millis() - t >= 100) { t = millis(); on = !on; digitalWrite(OUT, on); }
  int b = digitalRead(IN);
  if (b != last) {
    last = b;
    Serial.printf("in=%d t=%lu\n", b, millis());
    digitalWrite(LED_BUILTIN, b);
  }
  delay(1);
}
