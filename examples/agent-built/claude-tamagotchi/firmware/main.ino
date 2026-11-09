// Tamagotchi-style pet for Arduino Uno
// OLED SSD1306 128x64 on I2C (A4/A5), buttons FEED=D2 PLAY=D4 SLEEP=D7 (INPUT_PULLUP, to GND),
// active buzzer on D8.
//
// Stats are 0..100:
//   hunger    - higher = hungrier (rises over time, FEED lowers it)
//   happiness - falls over time (faster when hungry or exhausted), PLAY raises it
//   energy    - falls while awake, PLAY costs energy, SLEEP restores it
// Serial log (115200) every second: "t=12 hunger=44 happy=68 energy=74 mood=happy"
#include "pet_types.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const uint8_t PIN_FEED = 2, PIN_PLAY = 4, PIN_SLEEP = 7, PIN_BUZZ = 8;
const uint8_t OLED_ADDR = 0x3C;

const unsigned long TICK_MS = 1000;      // stats update period
const unsigned long FRAME_MS = 200;      // face animation period
const unsigned long ALERT_EVERY_MS = 4000;
const unsigned long BEEP_MS = 120;

// Need thresholds
const int HUNGRY_AT = 70;    // hunger >= 70 -> needs food
const int SAD_BELOW = 35;    // happiness < 35 -> sad, needs play
const int TIRED_BELOW = 20;  // energy < 20 -> needs sleep

Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool haveDisplay = false;

int hunger = 20, happiness = 80, energy = 80;
bool sleeping = false;
unsigned long tickCount = 0;

Mood mood = HAPPY;
const char *moodName(Mood m) {
  switch (m) {
    case HAPPY: return "happy";
    case OK: return "ok";
    case HUNGRY: return "hungry";
    case SAD: return "sad";
    case TIRED: return "tired";
    default: return "sleeping";
  }
}

// ---------- buttons (edge detect + debounce) ----------
Button buttons[3] = {{PIN_FEED, true, 0}, {PIN_PLAY, true, 0}, {PIN_SLEEP, true, 0}};

bool pressedEdge(Button &b) {
  bool level = digitalRead(b.pin);
  unsigned long now = millis();
  if (level != b.last && now - b.changedAt > 25) {
    b.last = level;
    b.changedAt = now;
    return level == LOW;
  }
  return false;
}

// ---------- buzzer (non-blocking) ----------
unsigned long buzzOffAt = 0;
uint8_t beepsQueued = 0;
unsigned long nextBeepAt = 0;
unsigned long lastAlertAt = 0;

void beep(uint8_t count) {
  beepsQueued = count;
  nextBeepAt = millis();
}

void updateBuzzer() {
  unsigned long now = millis();
  if (buzzOffAt && now >= buzzOffAt) {
    digitalWrite(PIN_BUZZ, LOW);
    buzzOffAt = 0;
  }
  if (beepsQueued && !buzzOffAt && now >= nextBeepAt) {
    digitalWrite(PIN_BUZZ, HIGH);
    buzzOffAt = now + BEEP_MS;
    nextBeepAt = now + BEEP_MS * 2;
    beepsQueued--;
  }
}

// ---------- pet logic ----------
int clamp100(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

Mood computeMood() {
  if (sleeping) return SLEEPING;
  if (happiness < SAD_BELOW) return SAD;
  if (hunger >= HUNGRY_AT) return HUNGRY;
  if (energy < TIRED_BELOW) return TIRED;
  if (happiness >= 65 && hunger < 50) return HAPPY;
  return OK;
}

// Most urgent need, or nullptr if none.
const char *currentNeed() {
  if (sleeping) return nullptr;
  if (hunger >= HUNGRY_AT) return "food";
  if (energy < TIRED_BELOW) return "sleep";
  if (happiness < SAD_BELOW) return "play";
  return nullptr;
}

void logState() {
  Serial.print(F("t="));
  Serial.print(millis() / 1000);
  Serial.print(F(" hunger="));
  Serial.print(hunger);
  Serial.print(F(" happy="));
  Serial.print(happiness);
  Serial.print(F(" energy="));
  Serial.print(energy);
  Serial.print(F(" mood="));
  Serial.println(moodName(mood));
}

void updateMood() {
  Mood m = computeMood();
  if (m != mood) {
    Serial.print(F("MOOD "));
    Serial.print(moodName(mood));
    Serial.print(F(" -> "));
    Serial.println(moodName(m));
    mood = m;
  }
}

void tick() {
  tickCount++;
  if (sleeping) {
    energy = clamp100(energy + 4);
    if (tickCount % 2 == 0) hunger = clamp100(hunger + 1);
    if (energy >= 100) {
      sleeping = false;
      Serial.println(F("EVENT wake: rested"));
      beep(1);
    }
  } else {
    hunger = clamp100(hunger + 2);
    if (tickCount % 2 == 0) energy = clamp100(energy - 1);
    int drop = 1;
    if (hunger >= HUNGRY_AT) drop++;
    if (energy < TIRED_BELOW) drop++;
    happiness = clamp100(happiness - drop);
  }
  updateMood();
  logState();

  const char *need = currentNeed();
  unsigned long now = millis();
  if (need && (lastAlertAt == 0 || now - lastAlertAt >= ALERT_EVERY_MS)) {
    lastAlertAt = now;
    Serial.print(F("BEEP need="));
    Serial.println(need);
    beep(2);
  }
  if (!need) lastAlertAt = 0;
}

void onFeed() {
  if (sleeping) { Serial.println(F("EVENT feed ignored: sleeping")); return; }
  hunger = clamp100(hunger - 30);
  happiness = clamp100(happiness + 3);
  Serial.print(F("EVENT feed: hunger="));
  Serial.println(hunger);
  beep(1);
  updateMood();
}

void onPlay() {
  if (sleeping) { Serial.println(F("EVENT play ignored: sleeping")); return; }
  if (energy < 10) { Serial.println(F("EVENT play refused: too tired")); beep(1); return; }
  happiness = clamp100(happiness + 20);
  energy = clamp100(energy - 8);
  hunger = clamp100(hunger + 5);
  Serial.print(F("EVENT play: happy="));
  Serial.println(happiness);
  beep(1);
  updateMood();
}

void onSleep() {
  sleeping = !sleeping;
  if (sleeping) Serial.println(F("EVENT sleep: zzz"));
  else Serial.println(F("EVENT wake: button"));
  beep(1);
  updateMood();
}

// ---------- drawing ----------
unsigned long frameNo = 0;

void drawBar(int x, const __FlashStringHelper *label, int value) {
  display.setCursor(x, 0);
  display.print(label);
  display.drawRect(x + 19, 0, 22, 7, SSD1306_WHITE);
  int w = value * 20 / 100;
  if (w > 0) display.fillRect(x + 20, 1, w, 5, SSD1306_WHITE);
}

// Parabolic mouth centred at (cx, cy): curve > 0 smile (ends raised), < 0 frown, 0 flat.
void drawMouth(int cx, int cy, int halfW, int curve) {
  int hw2 = halfW * halfW;
  int px = -halfW;
  int py = cy - curve;  // ends: y = cy - curve, middle: y = cy
  for (int x = -halfW + 2; x <= halfW; x += 2) {
    int y = cy - (curve * x * x) / hw2;
    display.drawLine(cx + px, py, cx + x, y, SSD1306_WHITE);
    display.drawLine(cx + px, py + 1, cx + x, y + 1, SSD1306_WHITE);
    px = x;
    py = y;
  }
}

void drawFace() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  drawBar(0, F("HUN"), hunger);
  drawBar(43, F("JOY"), happiness);
  drawBar(86, F("NRG"), energy);

  uint8_t f = frameNo % 16;
  int bob = (mood == HAPPY) ? ((frameNo % 4) < 2 ? 0 : -2) : 0;
  int cx = 64, cy = 37 + bob;
  display.drawRoundRect(cx - 34, cy - 26, 68, 52, 14, SSD1306_WHITE);  // head

  int ex1 = cx - 13, ex2 = cx + 13, ey = cy - 8;
  bool blink = (f == 7);

  switch (mood) {
    case SLEEPING: {
      display.drawLine(ex1 - 5, ey, ex1 + 5, ey, SSD1306_WHITE);
      display.drawLine(ex2 - 5, ey, ex2 + 5, ey, SSD1306_WHITE);
      display.drawCircle(cx, cy + 10, 2 + (frameNo % 4 < 2 ? 0 : 1), SSD1306_WHITE);
      int zy = 34 - (frameNo % 8) * 2;  // floating Zz
      display.setCursor(104, zy);
      display.print('z');
      display.setCursor(112, zy - 8);
      display.print('Z');
      break;
    }
    case TIRED: {
      display.fillRect(ex1 - 5, ey - 1, 11, 3, SSD1306_WHITE);  // droopy eyes
      display.fillRect(ex2 - 5, ey - 1, 11, 3, SSD1306_WHITE);
      if (frameNo % 10 < 5) display.drawCircle(cx, cy + 11, 3, SSD1306_WHITE);  // yawn
      else display.drawLine(cx - 5, cy + 11, cx + 5, cy + 11, SSD1306_WHITE);
      break;
    }
    default: {
      if (blink) {
        display.drawLine(ex1 - 5, ey, ex1 + 5, ey, SSD1306_WHITE);
        display.drawLine(ex2 - 5, ey, ex2 + 5, ey, SSD1306_WHITE);
      } else {
        display.fillCircle(ex1, ey, 5, SSD1306_WHITE);
        display.fillCircle(ex2, ey, 5, SSD1306_WHITE);
        int look = (f < 4) ? -1 : (f < 8 ? 1 : 0);  // pupils glance around
        display.fillCircle(ex1 + look * 2, ey - 1, 1, SSD1306_BLACK);
        display.fillCircle(ex2 + look * 2, ey - 1, 1, SSD1306_BLACK);
      }
      if (mood == HAPPY) {
        drawMouth(cx, cy + 14, 12, 6);
        display.fillCircle(cx - 25, cy + 4, 2, SSD1306_WHITE);  // cheeks
        display.fillCircle(cx + 25, cy + 4, 2, SSD1306_WHITE);
      } else if (mood == OK) {
        drawMouth(cx, cy + 12, 9, 2);
      } else if (mood == SAD) {
        drawMouth(cx, cy + 9, 10, -6);
        display.drawLine(ex1 - 6, ey - 7, ex1 + 4, ey - 10, SSD1306_WHITE);  // brows
        display.drawLine(ex2 + 6, ey - 7, ex2 - 4, ey - 10, SSD1306_WHITE);
        int ty = ey + 7 + (frameNo % 6) * 2;  // falling tear
        display.fillCircle(ex1 - 4, ty, 1, SSD1306_WHITE);
      } else if (mood == HUNGRY) {
        int r = 3 + (frameNo % 4 < 2 ? 0 : 2);  // chomping mouth
        display.drawCircle(cx, cy + 11, r, SSD1306_WHITE);
        display.setCursor(102, 56);
        display.print(F("food"));
      }
      break;
    }
  }
  display.display();
  frameNo++;
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_FEED, INPUT_PULLUP);
  pinMode(PIN_PLAY, INPUT_PULLUP);
  pinMode(PIN_SLEEP, INPUT_PULLUP);
  pinMode(PIN_BUZZ, OUTPUT);
  digitalWrite(PIN_BUZZ, LOW);

  Wire.begin();
  Wire.beginTransmission(OLED_ADDR);
  if (Wire.endTransmission() == 0 && display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    haveDisplay = true;
    Wire.setClock(400000);  // fast I2C: a frame takes ~25 ms so button polling stays snappy
    Serial.println(F("OLED ready"));
  } else {
    Serial.println(F("ERROR: OLED not found at 0x3C, running without screen"));
  }
  mood = computeMood();
  Serial.println(F("PET born"));
  logState();
  beep(1);
}

unsigned long lastTick = 0, lastFrame = 0;

void loop() {
  if (pressedEdge(buttons[0])) onFeed();
  if (pressedEdge(buttons[1])) onPlay();
  if (pressedEdge(buttons[2])) onSleep();

  unsigned long now = millis();
  if (now - lastTick >= TICK_MS) {
    lastTick += TICK_MS;
    tick();
  }
  if (haveDisplay && now - lastFrame >= FRAME_MS) {
    lastFrame = now;
    drawFace();
  }
  updateBuzzer();
}
