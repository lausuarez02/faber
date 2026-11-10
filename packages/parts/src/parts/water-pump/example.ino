// Plant waterer: soil probe on A0, active-LOW relay module on D7 switching the pump.
// Wiring: probe VCC → 5V, GND → GND, AOUT → A0. Relay VCC → 5V, GND → GND, IN → D7,
// COM → 5V, NO → pump +. Pump − → GND. (A real build powers the pump from its own 5 V supply.)
const int RELAY = 7;
const int DRY = 450;  // analogRead above this = dry soil (calibrate: air ~590, water ~255)

void setup() {
  digitalWrite(RELAY, HIGH);  // relay off before the pin becomes an output (no click at boot)
  pinMode(RELAY, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  int soil = analogRead(A0);
  Serial.print("soil=");
  Serial.println(soil);
  if (soil > DRY) {
    Serial.println("watering");
    digitalWrite(RELAY, LOW);   // pump on
    delay(3000);
    digitalWrite(RELAY, HIGH);  // pump off
  }
  delay(2000);
}
