// Fixture for esp32-s3-devkitc-1 (round 10): proves boot, GPIO out, GPIO in with the internal pull-up, and Serial.
// GPIO4 toggles every 100 ms; GPIO5 is INPUT_PULLUP and every change is printed.
const int OUT = 4;
const int IN = 5;
void setup() {
  Serial.begin(115200);
  pinMode(OUT, OUTPUT);
  pinMode(IN, INPUT_PULLUP);
  Serial.println("boot esp32-s3-devkitc-1");
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
