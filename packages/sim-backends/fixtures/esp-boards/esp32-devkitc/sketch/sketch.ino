// Fixture for esp32-devkitc (round 10): proves boot, GPIO out, GPIO in with the internal pull-up, and Serial.
// GPIO2 toggles every 100 ms; GPIO4 is INPUT_PULLUP and every change is printed.
const int OUT = 2;
const int IN = 4;
void setup() {
  Serial.begin(115200);
  pinMode(OUT, OUTPUT);
  pinMode(IN, INPUT_PULLUP);
  Serial.println("boot esp32-devkitc");
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
  }
  delay(1);
}
