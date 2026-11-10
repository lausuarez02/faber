// Pocket Muse: a tiny pocket buddy with round animated eyes.
//  - calm:   warm eyes, blinks, glances around, eyes slide when tilted
//  - love:   press the pet button -> happy ^^ eyes, pink cheeks, chirp
//  - scared: sudden move / drop    -> wide eyes, tiny shaking pupils, "eek!"
//  - dizzy:  keep shaking it        -> spinning spiral eyes, wobbly sound
//  - sleepy: left alone 30 s        -> sleepy line eyes, screen dims
#include "types.h"
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include "gc9a01.h"

// ---- pins (XIAO RP2040) ----
const int PIN_BTN  = D0;   // pet button to GND
const int PIN_BUZZ = D1;   // passive buzzer
const int PIN_RST  = D2;
const int PIN_DC   = D3;
const int PIN_BL   = D6;   // screen backlight
const int PIN_CS   = D7;

GC9A01 tft(PIN_CS, PIN_DC, PIN_RST);
Adafruit_MPU6050 mpu;
bool imuOk = false;

// Drawing area holding both eyes (pushed to the screen in one go).
const int CX0 = 20, CY0 = 50, CW = 200, CH = 140;
GFXcanvas16 canvas(CW, CH);

// ---- colours (RGB565) ----
uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
uint16_t C_WARM, C_PINK, C_WHITE, C_DIZZY, C_SLEEP;

// ---- moods ----
const char *MOOD_NAME[] = {"calm", "love", "scared", "dizzy", "sleepy"};
Mood mood = CALM;
uint32_t moodSince = 0;

// ---- timing / thresholds ----
const uint32_t LOVE_MS = 2500;        // happy face after a pet
const uint32_t SETTLE_MS = 2000;      // still this long -> scared/dizzy calm down
const uint32_t DIZZY_AFTER_MS = 1200; // this much shaking -> dizzy
const uint32_t SLEEP_AFTER_MS = 30000;
const float SPIKE_G = 0.8;            // |a| away from 1 g by this much = a jolt
const float SPIN_DPS = 200;           // fast rotation
const float FREEFALL_G = 0.35;        // nearly weightless = falling

// ---- state ----
float ax = 0, ay = 0, az = 1, gmag = 0;
float lookX = 0, lookY = 0;            // smoothed eye position (px)
float targetX = 0, targetY = 0;
uint32_t nextGlance = 0;
uint32_t lastMotion = 0, lastInteract = 0;
uint32_t shakeMs = 0;
uint32_t nextBlink = 0, blinkEnd = 0;
bool lastBtn = HIGH;
uint32_t btnChanged = 0;
int pets = 0;
float prevAx = 0, prevAy = 0;
int32_t lastKey = -1;                  // what the screen shows now (skip identical redraws)

// ---- non-blocking sound player ----
const Note S_HELLO[] = {{1200, 70}, {0, 40}, {1800, 90}};
const Note S_LOVE[]  = {{1568, 80}, {2093, 80}, {2637, 140}};
const Note S_EEK[]   = {{2400, 60}, {3200, 140}};
const Note S_DIZZY[] = {{700, 90}, {500, 90}, {700, 90}, {500, 90}, {400, 160}};
const Note S_PHEW[]  = {{1400, 100}, {900, 180}};
const Note S_YAWN[]  = {{600, 200}, {450, 250}};
const Note *seq = nullptr;
int seqLen = 0, seqIdx = 0;
uint32_t noteEnd = 0;

void play(const Note *s, int n) { seq = s; seqLen = n; seqIdx = -1; noteEnd = 0; }
#define PLAY(s) play(s, sizeof(s) / sizeof(s[0]))

void updateSound(uint32_t now) {
  if (!seq || now < noteEnd) return;
  seqIdx++;
  if (seqIdx >= seqLen) { noTone(PIN_BUZZ); seq = nullptr; return; }
  const Note &n = seq[seqIdx];
  if (n.hz) tone(PIN_BUZZ, n.hz); else noTone(PIN_BUZZ);
  noteEnd = now + n.ms;
}

void enterMood(Mood m, uint32_t now) {
  Mood old = mood;
  mood = m;
  moodSince = now;
  lastKey = -1;
  analogWrite(PIN_BL, m == SLEEPY ? 40 : 255);
  Serial.print("mood=");
  Serial.print(MOOD_NAME[m]);
  if (m == LOVE) { Serial.print(" pets="); Serial.print(pets); }
  Serial.println();
  switch (m) {
    case LOVE:   PLAY(S_LOVE); break;
    case SCARED: PLAY(S_EEK); break;
    case DIZZY:  PLAY(S_DIZZY); break;
    case SLEEPY: PLAY(S_YAWN); break;
    case CALM:   if (old == SCARED || old == DIZZY) PLAY(S_PHEW); break;
  }
}

void setMood(Mood m, uint32_t now) {
  if (m != mood) enterMood(m, now);
}

// ---------------------------------------------------------------- drawing
// Eye centres inside the canvas (screen x = 78 / 162, y = 120).
const int EYE_L = 58, EYE_R = 142, EYE_Y = 70;

void drawCalmEye(int cx, int cy, float open) {
  int w = 62, h = max(7, (int)(88 * open));
  canvas.fillRoundRect(cx - w / 2, cy - h / 2, w, h, min(22, h / 2), C_WARM);
  // a little sparkle so it feels alive
  if (open > 0.6) canvas.fillCircle(cx + 13, cy - h / 4, 6, C_WHITE);
}

void drawLoveEye(int cx, int cy) {
  // happy ^ arc: a disc with a black disc below cut out of it
  canvas.fillCircle(cx, cy, 32, C_PINK);
  canvas.fillCircle(cx, cy + 16, 32, 0);
  canvas.fillRect(cx - 35, cy + 2, 70, 45, 0);
}

void drawScaredEye(int cx, int cy, int jx, int jy) {
  canvas.fillCircle(cx, cy, 38, C_WHITE);
  canvas.fillCircle(cx + jx, cy + jy, 9, 0);
}

void drawDizzyEye(int cx, int cy, float phase) {
  float px = cx, py = cy;
  for (float a = 0; a < 4 * PI; a += 0.25) {
    float r = 2 + a * 2.7;
    float x = cx + r * cos(a + phase), y = cy + r * sin(a + phase);
    canvas.drawLine(px, py, x, y, C_DIZZY);
    canvas.drawLine(px + 1, py, x + 1, y, C_DIZZY);
    px = x; py = y;
  }
}

void drawSleepyEye(int cx, int cy) {
  canvas.fillRoundRect(cx - 30, cy + 6, 60, 8, 4, C_SLEEP);
}

// A number that changes whenever the picture should change; animated
// moods (scared, dizzy) change it every frame, still ones only on events.
int32_t frameKey(uint32_t now) {
  bool blinking = now < blinkEnd;
  switch (mood) {
    case CALM:   return (CALM << 24) | (blinking << 20) | (((int)lookX + 64) << 8) | ((int)lookY + 64);
    case LOVE:   return LOVE << 24;
    case SLEEPY: return (SLEEPY << 24) | (now / 300);
    default:     return (mood << 24) | ((now / 40) & 0xFFFFF);
  }
}

void render(uint32_t now) {
  canvas.fillScreen(0);
  int ox = (int)lookX, oy = (int)lookY;
  switch (mood) {
    case CALM: {
      float open = (now < blinkEnd) ? 0.08 : 1.0;
      drawCalmEye(EYE_L + ox, EYE_Y + oy, open);
      drawCalmEye(EYE_R + ox, EYE_Y + oy, open);
      break;
    }
    case LOVE:
      drawLoveEye(EYE_L, EYE_Y);
      drawLoveEye(EYE_R, EYE_Y);
      canvas.fillRoundRect(EYE_L - 36, EYE_Y + 34, 24, 11, 5, C_PINK);  // cheeks
      canvas.fillRoundRect(EYE_R + 12, EYE_Y + 34, 24, 11, 5, C_PINK);
      break;
    case SCARED: {
      int sx = random(-4, 5), sy = random(-3, 4);    // whole face trembles
      int jx = random(-3, 4), jy = random(-3, 4);    // pupils dart
      drawScaredEye(EYE_L + sx, EYE_Y + sy, jx, jy);
      drawScaredEye(EYE_R + sx, EYE_Y + sy, jx, jy);
      break;
    }
    case DIZZY: {
      float ph = now / 120.0;
      drawDizzyEye(EYE_L, EYE_Y, ph);
      drawDizzyEye(EYE_R, EYE_Y, -ph);
      break;
    }
    case SLEEPY:
      drawSleepyEye(EYE_L, EYE_Y);
      drawSleepyEye(EYE_R, EYE_Y);
      canvas.setTextColor(C_SLEEP);
      canvas.setTextSize(2);
      canvas.setCursor(165, 20 + (int)(4 * sin(now / 600.0)));
      canvas.print("z");
      break;
  }
  tft.drawRGBBitmap(CX0, CY0, canvas.getBuffer(), CW, CH);
}

// ---------------------------------------------------------------- sensing
void readMotion() {
  if (!imuOk) return;
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  ax = a.acceleration.x / 9.80665;
  ay = a.acceleration.y / 9.80665;
  az = a.acceleration.z / 9.80665;
  gmag = sqrt(sq(g.gyro.x) + sq(g.gyro.y) + sq(g.gyro.z)) * 57.2958;
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_BUZZ, OUTPUT);
  pinMode(PIN_BL, OUTPUT);
  analogWrite(PIN_BL, 255);

  C_WARM = rgb(255, 196, 120);   // warm peach
  C_PINK = rgb(255, 110, 170);
  C_WHITE = rgb(255, 255, 255);
  C_DIZZY = rgb(170, 255, 90);
  C_SLEEP = rgb(140, 150, 255);

  tft.begin();
  tft.fillScreen(0);

  Wire.begin();
  imuOk = mpu.begin(0x68);
  if (imuOk) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_1000_DEG);
    Serial.println("motion sensor ready");
  } else {
    Serial.println("motion sensor missing: check SDA/SCL wiring");
  }

  randomSeed(analogRead(A3));
  uint32_t now = millis();
  lastInteract = now;
  nextBlink = now + 2500;
  nextGlance = now + 3000;
  PLAY(S_HELLO);
  Serial.println("Pocket Muse awake");
  Serial.println("mood=calm");
}

uint32_t lastFrame = 0, lastLoop = 0, lastLookPrint = 0;

void loop() {
  uint32_t now = millis();
  uint32_t dt = now - lastLoop;
  if (dt < 20) { updateSound(now); delay(1); return; }   // rest instead of spinning
  lastLoop = now;

  readMotion();
  float amag = sqrt(ax * ax + ay * ay + az * az);
  bool freefall = imuOk && amag < FREEFALL_G;
  bool jolt = imuOk && (fabs(amag - 1.0) > SPIKE_G || gmag > SPIN_DPS);
  bool moving = freefall || jolt;

  if (moving) {
    lastMotion = now;
    lastInteract = now;
    shakeMs += dt;
  } else {
    shakeMs = (shakeMs > dt * 2) ? shakeMs - dt * 2 : 0;
  }

  // a gentle tilt also counts as attention (wakes it up)
  if (fabs(ax - prevAx) > 0.3 || fabs(ay - prevAy) > 0.3) {
    lastInteract = now;
    prevAx = ax; prevAy = ay;
  }

  // ---- pet button (debounced, on press) ----
  bool btn = digitalRead(PIN_BTN);
  if (btn != lastBtn && now - btnChanged > 30) {
    btnChanged = now;
    lastBtn = btn;
    if (btn == LOW) {
      pets++;
      lastInteract = now;
      if (mood == SCARED || mood == DIZZY) Serial.println("calmed by a pet");
      shakeMs = 0;
      lastMotion = 0;
      enterMood(LOVE, now);   // every pet gets a chirp, even if already happy
    }
  }

  // ---- mood rules ----
  if (mood != LOVE || now - moodSince > 300) {   // a pet wins for a moment
    if (freefall) setMood(SCARED, now);
    else if (moving && shakeMs > DIZZY_AFTER_MS) setMood(DIZZY, now);
    else if (moving && mood != DIZZY) setMood(SCARED, now);
  }
  if ((mood == SCARED || mood == DIZZY) && now - lastMotion > SETTLE_MS) setMood(CALM, now);
  if (mood == LOVE && now - moodSince > LOVE_MS) setMood(CALM, now);
  if (mood == CALM && now - lastInteract > SLEEP_AFTER_MS) setMood(SLEEPY, now);
  if (mood == SLEEPY && now - lastInteract < 100) setMood(CALM, now);

  // ---- where the eyes look ----
  if (mood == CALM) {
    bool tilted = fabs(ax) > 0.15 || fabs(ay) > 0.15;
    if (tilted) {
      targetX = constrain(-ax * 60, -30, 30);   // eyes slide toward the low side
      targetY = constrain(ay * 45, -22, 22);
    } else if (now > nextGlance) {
      // glance around, but mostly look straight at you
      if (random(3) == 0) { targetX = random(-22, 23); targetY = random(-12, 13); }
      else { targetX = 0; targetY = 0; }
      nextGlance = now + random(1500, 4000);
    }
    if (now > nextBlink) {
      blinkEnd = now + 130;
      nextBlink = now + random(2500, 5500);
    }
  } else {
    targetX = 0; targetY = 0;
  }
  lookX += (targetX - lookX) * 0.3;
  lookY += (targetY - lookY) * 0.3;
  if (fabs(targetX - lookX) < 0.5) lookX = targetX;
  if (fabs(targetY - lookY) < 0.5) lookY = targetY;
  if (now - lastLookPrint > 500 && mood == CALM) {
    lastLookPrint = now;
    Serial.print("look x="); Serial.print((int)lookX);
    Serial.print(" y="); Serial.println((int)lookY);
  }

  updateSound(now);
  if (now - lastFrame >= 40) {   // up to ~25 fps, only when the face changed
    lastFrame = now;
    int32_t key = frameKey(now);
    if (key != lastKey) {
      lastKey = key;
      render(now);
    }
  }
}
