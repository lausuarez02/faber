// Passive buzzer on D8: play C4 E4 G4 C5, then report. tone() works on any pin.
const int BUZZER = 8;
const int NOTES[] = {262, 330, 392, 523};

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 4; i++) {
    tone(BUZZER, NOTES[i]);
    delay(200);
    noTone(BUZZER);
    delay(50);
  }
  Serial.println("melody done");
}

void loop() {}
