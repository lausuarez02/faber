// Talking egg: press the button and it says something.
// Arduino Nano + DFPlayer Mini (MP3 player with a microSD card) + 8 ohm speaker + push button.
// No library: the DFPlayer takes 10-byte frames at 9600 baud (dfSend below builds them).
//
// Wiring: DFPlayer VCC -> 5V, GND -> GND, RX <- D11 through 1k, TX -> D10, SPK_1 / SPK_2 -> speaker.
// Button between D2 and GND (INPUT_PULLUP: pressed reads LOW).
// The words of each track are the DFPlayer's "clips" (1: hi! I'm Eggy, 2: whoa, I'm dizzy!, ...).
#include <SoftwareSerial.h>

SoftwareSerial dfSerial(10, 11);  // RX (from DFPlayer TX), TX (to DFPlayer RX)

const int BUTTON = 2;
const int TRACKS = 4;   // clips 2..4 are the button lines, 1 is the greeting
int nextLine = 2;
bool wasDown = false;
unsigned long lastPress = 0;

// Send one DFPlayer command: 7E FF 06 CMD FB PH PL CHK_H CHK_L EF, CHK = 0 - sum(FF..PL).
void dfSend(uint8_t cmd, uint16_t param) {
  uint8_t f[10] = {0x7E, 0xFF, 0x06, cmd, 0x00, (uint8_t)(param >> 8), (uint8_t)(param & 0xFF), 0, 0, 0xEF};
  uint16_t sum = 0;
  for (int i = 1; i < 7; i++) sum += f[i];
  uint16_t chk = (uint16_t)(0 - sum);
  f[7] = chk >> 8;
  f[8] = chk & 0xFF;
  dfSerial.write(f, 10);
}

void say(int track) {
  dfSend(0x03, track);  // play track N
  Serial.print("say ");
  Serial.println(track);
}

// Read the DFPlayer's replies: 0x3F = online, 0x3D = finished a track.
uint8_t rx[10];
int rxLen = 0;
void readReplies() {
  while (dfSerial.available()) {
    uint8_t b = dfSerial.read();
    if (rxLen == 0 && b != 0x7E) continue;
    rx[rxLen++] = b;
    if (rxLen == 10) {
      rxLen = 0;
      if (rx[9] != 0xEF) continue;
      uint16_t param = (rx[5] << 8) | rx[6];
      if (rx[3] == 0x3F) Serial.println("player online");
      if (rx[3] == 0x3D) {
        Serial.print("done ");
        Serial.println(param);
      }
    }
  }
}

void setup() {
  Serial.begin(9600);
  pinMode(BUTTON, INPUT_PULLUP);
  dfSerial.begin(9600);
  delay(1500);         // the DFPlayer scans its card for about a second after power-up
  readReplies();
  dfSend(0x06, 22);    // volume 22 of 30
  delay(30);
  say(1);              // "hi! I'm Eggy"
}

void loop() {
  readReplies();
  bool down = digitalRead(BUTTON) == LOW;
  if (down && !wasDown && millis() - lastPress > 150) {
    lastPress = millis();
    say(nextLine);
    nextLine = nextLine >= TRACKS ? 2 : nextLine + 1;
  }
  wasDown = down;
  delay(5);
}
