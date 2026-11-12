// Talking Egg: two animated eyes on one little screen + a voice.
// XIAO RP2040, SSD1306 OLED (eyes), DFPlayer Mini (voice) on Serial1.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

const int BUSY_PIN = D0;   // DFPlayer BUSY: LOW while talking
const int BAT_PIN  = A1;   // battery through 100k/100k divider
const int NUM_CLIPS = 5;   // clips on the microSD card
const float LOW_BAT_V = 3.35;

// ---------- voice ----------
void dfSend(uint8_t cmd, uint16_t param) {
  uint8_t f[10] = {0x7E, 0xFF, 0x06, cmd, 0x00, (uint8_t)(param >> 8), (uint8_t)(param & 0xFF), 0, 0, 0xEF};
  uint16_t sum = 0;
  for (int i = 1; i < 7; i++) sum += f[i];
  uint16_t chk = (uint16_t)(0 - sum);
  f[7] = chk >> 8;
  f[8] = chk & 0xFF;
  Serial1.write(f, 10);
}

void say(int clip) {
  dfSend(0x03, clip);
  Serial.print("say clip ");
  Serial.println(clip);
}

bool talking() { return digitalRead(BUSY_PIN) == LOW; }

// ---------- battery ----------
// The ADC compares against the board's 3.3 V rail, which sags once the
// cell is under ~3.85 V (diode + regulator drop). Correct for that.
bool sagging = false;
float batteryVolts() {
  long sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(BAT_PIN);
  float v = (sum / 8.0) * 3.3 / 1023.0 * 2.0;   // as if the rail were 3.3 V
  if (v > 4.1) sagging = false;                  // clearly a full-ish cell
  if (v < 3.87) sagging = true;                  // we've reached the sag zone
  if (sagging && v > 3.85) v = 0.55 * v / (v - 3.3);  // rail = cell - 0.55 V
  return v;
}

// ---------- eyes ----------
enum Mood { NORMAL, HAPPY, SLEEPY };
int lookX = 0, lookY = 0;   // where the pupils point
float lid = 0;              // 0 = open, 1 = closed

void drawEye(int cx, int cy, Mood mood) {
  const int w = 34, h = 40;
  int openH = (int)(h * (1.0 - lid));
  if (openH < 3) {                       // closed: a line
    display.fillRoundRect(cx - w / 2, cy - 1, w, 3, 1, SSD1306_WHITE);
    return;
  }
  if (mood == HAPPY) {                   // ^ ^ squint while talking
    display.fillCircle(cx, cy + 6, w / 2, SSD1306_WHITE);
    display.fillCircle(cx, cy + 14, w / 2, SSD1306_BLACK);
    return;
  }
  if (mood == SLEEPY) openH = min(openH, h / 3);
  display.fillRoundRect(cx - w / 2, cy - openH / 2, w, openH, 10, SSD1306_WHITE);
  // pupil + little shine
  int px = cx + lookX, py = cy + lookY;
  int pr = min(9, openH / 2 - 2);
  if (pr > 2) {
    display.fillCircle(px, py, pr, SSD1306_BLACK);
    display.fillCircle(px - 3, py - 3, 2, SSD1306_WHITE);
  }
}

void drawFace(Mood mood) {
  display.clearDisplay();
  drawEye(36, 32, mood);
  drawEye(92, 32, mood);
  display.display();
}

// ---------- behaviour ----------
unsigned long nextBlink = 2000, nextLook = 1500, nextTalk = 0;
unsigned long blinkStart = 0;
bool blinking = false;
bool asleep = false;

void setup() {
  Serial.begin(115200);
  pinMode(BUSY_PIN, INPUT_PULLUP);
  analogReadResolution(10);
  randomSeed(analogRead(A2) ^ micros());

  Wire.begin();
  Wire.beginTransmission(0x3C);
  if (Wire.endTransmission() != 0 || !display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("eyes screen not found: check wiring");
  } else {
    Serial.println("eyes ready");
  }
  drawFace(NORMAL);

  Serial1.begin(9600);
  delay(1500);               // voice module reads its card
  dfSend(0x06, 22);          // volume 0..30
  say(1);                    // "Hi! I'm Eggy!"
  nextTalk = millis() + 8000;
}

void loop() {
  unsigned long now = millis();

  // battery check once a second
  static unsigned long nextBat = 0;
  if (now >= nextBat) {
    nextBat = now + 1000;
    float v = batteryVolts();
    static unsigned long nextPrint = 0;
    if (now >= nextPrint) { nextPrint = now + 10000; Serial.print("battery "); Serial.println(v, 2); }
    if (!asleep && v < LOW_BAT_V && v > 1.0) {   // > 1 V: a cell is actually there
      asleep = true;
      Serial.println("low battery: going to sleep");
      say(5);                                    // "Yawn... I'm sleepy."
    }
  }

  if (asleep) {
    lid = 0.7;
    drawFace(SLEEPY);
    delay(200);
    return;
  }

  // blink every 2-5 s
  if (!blinking && now >= nextBlink) { blinking = true; blinkStart = now; }
  if (blinking) {
    unsigned long t = now - blinkStart;
    if (t < 80) lid = t / 80.0;
    else if (t < 160) lid = 1.0 - (t - 80) / 80.0;
    else { lid = 0; blinking = false; nextBlink = now + random(2000, 5000); }
  }

  // look somewhere new now and then
  if (now >= nextLook) {
    lookX = random(-8, 9);
    lookY = random(-5, 6);
    nextLook = now + random(800, 2500);
  }

  // say something every 8-15 s
  if (now >= nextTalk && !talking()) {
    say(random(2, NUM_CLIPS));     // clips 2..4 (5 is for bedtime)
    nextTalk = now + random(8000, 15000);
  }

  drawFace(talking() ? HAPPY : NORMAL);
  delay(30);
}
