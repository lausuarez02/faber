// Fixture for seeed-xiao-esp32s3-sense (round 13; the Sense board, built with its PSRAM=opi simulator FQBN): proves boot, GPIO out, GPIO in with the internal pull-up, and Serial.
// GPIO1 toggles every 100 ms; GPIO2 is INPUT_PULLUP and every change is printed.
const int OUT = 1;
const int IN = 2;
void setup() {
  Serial.begin(115200);
  pinMode(OUT, OUTPUT);
  pinMode(IN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("boot seeed-xiao-esp32s3-sense");
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
