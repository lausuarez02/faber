// Star keychain: two big mint-green eyes on a round 1.28" screen.
// They blink every few seconds and glance around; a tiny nose sits between them.
// Board: Seeed XIAO RP2040. Screen: GC9A01 240x240 round (SPI0: SCK GP2, MOSI GP3).
// Power: LiPo -> TP4056 (USB-C charging) -> switch -> MCP1700 3.3 V -> XIAO 3V3.
// Cell level on GP28 through a 100k/100k divider (taken after the switch: no drain when off).
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SPITFT.h>

class GC9A01 : public Adafruit_SPITFT {
public:
  GC9A01(int8_t cs, int8_t dc, int8_t rst) : Adafruit_SPITFT(240, 240, cs, dc, rst) {}
  void begin(uint32_t freq = 40000000) {
    initSPI(freq);
    static const uint8_t init[] PROGMEM = {
      0xEF, 0, 0xEB, 1, 0x14, 0xFE, 0, 0xEF, 0, 0xEB, 1, 0x14,
      0x84, 1, 0x40, 0x85, 1, 0xFF, 0x86, 1, 0xFF, 0x87, 1, 0xFF, 0x88, 1, 0x0A, 0x89, 1, 0x21,
      0x8A, 1, 0x00, 0x8B, 1, 0x80, 0x8C, 1, 0x01, 0x8D, 1, 0x01, 0x8E, 1, 0xFF, 0x8F, 1, 0xFF,
      0xB6, 2, 0x00, 0x20,
      0x36, 1, 0x08,
      0x3A, 1, 0x05,
      0x90, 4, 0x08, 0x08, 0x08, 0x08, 0xBD, 1, 0x06, 0xBC, 1, 0x00, 0xFF, 3, 0x60, 0x01, 0x04,
      0xC3, 1, 0x13, 0xC4, 1, 0x13, 0xC9, 1, 0x22, 0xBE, 1, 0x11, 0xE1, 2, 0x10, 0x0E,
      0xDF, 3, 0x21, 0x0C, 0x02,
      0xF0, 6, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A, 0xF1, 6, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F,
      0xF2, 6, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A, 0xF3, 6, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F,
      0xED, 2, 0x1B, 0x0B, 0xAE, 1, 0x77, 0xCD, 1, 0x63,
      0x70, 9, 0x07, 0x07, 0x04, 0x0E, 0x0F, 0x09, 0x07, 0x08, 0x03,
      0xE8, 1, 0x34,
      0x62, 12, 0x18, 0x0D, 0x71, 0xED, 0x70, 0x70, 0x18, 0x0F, 0x71, 0xEF, 0x70, 0x70,
      0x63, 12, 0x18, 0x11, 0x71, 0xF1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xF3, 0x70, 0x70,
      0x64, 7, 0x28, 0x29, 0xF1, 0x01, 0xF1, 0x00, 0x07,
      0x66, 10, 0x3C, 0x00, 0xCD, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00,
      0x67, 10, 0x00, 0x3C, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98,
      0x74, 7, 0x10, 0x85, 0x80, 0x00, 0x00, 0x4E, 0x00,
      0x98, 2, 0x3E, 0x07,
      0x35, 0, 0x21, 0, 0x11, 0x80, 0x29, 0x80, 0x00
    };
    const uint8_t *p = init;
    uint8_t cmd;
    while ((cmd = pgm_read_byte(p++)) != 0) {
      uint8_t n = pgm_read_byte(p++);
      sendCommand(cmd, p, n & 0x7F);
      p += n & 0x7F;
      if (n & 0x80) delay(120);
    }
    _width = 240; _height = 240;
  }
  void sleepPanel() { sendCommand(0x28); delay(20); sendCommand(0x10); }
  void setAddrWindow(uint16_t x, uint16_t y, uint16_t w, uint16_t h) override {
    writeCommand(0x2A); SPI_WRITE16(x); SPI_WRITE16(x + w - 1);
    writeCommand(0x2B); SPI_WRITE16(y); SPI_WRITE16(y + h - 1);
    writeCommand(0x2C);
  }
};

// Pins (XIAO RP2040)
const int PIN_CS = 1, PIN_DC = 27, PIN_RST = 26, PIN_BAT = 28;
GC9A01 tft(PIN_CS, PIN_DC, PIN_RST);

// Colours (RGB565)
const uint16_t BG    = 0x0000;  // black glass
const uint16_t MINT  = 0x9FF9;  // mint green #98FFCC
const uint16_t SHINE = 0xFFFF;  // white sparkle
const uint16_t NOSE  = 0x6E73;  // deeper mint for the nose

// Face is drawn into an off-screen canvas, then pushed in one go (no flicker).
const int FX = 20, FY = 46, FW = 200, FH = 136;
GFXcanvas16 face(FW, FH);

// Eye geometry (screen coords)
const int EYE_W = 56, EYE_H = 72, EYE_R = 26, EYE_GAP = 44, EYE_Y = 108;
const int NOSE_Y = 156;

// Sleep threshold. The MCP1700 holds 3.3 V down to a cell of ~3.48 V; below that the rail
// follows the cell and the divider reads ~3.5 V whatever the cell does, so 3.55 V catches
// both "getting low" and "already in dropout".
const float LOW_BATTERY_V = 3.55f;

float lookX = 0, lookY = 0;        // current gaze offset (px)
float targetX = 0, targetY = 0;    // where the eyes are heading
unsigned long nextLook = 1500, nextBlink = 2500, blinkStart = 0;
bool blinking = false, doubleBlink = false;
const int BLINK_MS = 160;
unsigned long lastFrame = 0, lastBat = 0;
bool asleep = false;

float readBattery() {
  long sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(PIN_BAT);
  return (sum / 8.0f) * 3.3f / 1023.0f * 2.0f;
}

void drawEye(int cx, int cy, float open) {
  int h = max(6, (int)(EYE_H * open));
  int r = min(EYE_R, h / 2);
  face.fillRoundRect(cx - EYE_W / 2 - FX, cy - h / 2 - FY, EYE_W, h, r, MINT);
  if (open > 0.45f) {  // sparkles only when the eye is open enough
    face.fillCircle(cx - 12 - FX, cy - h / 4 - FY, 9, SHINE);
    face.fillCircle(cx + 10 - FX, cy + h / 6 - FY, 4, SHINE);
  }
}

void drawFace(float open) {
  face.fillScreen(BG);
  int ox = (int)lookX, oy = (int)lookY;
  drawEye(120 - EYE_GAP + ox, EYE_Y + oy, open);
  drawEye(120 + EYE_GAP + ox, EYE_Y + oy, open);
  // tiny rounded nose, moving a little less than the eyes (feels 3D)
  int nx = 120 + ox / 2 - FX, ny = NOSE_Y + oy / 2 - FY;
  face.fillTriangle(nx - 6, ny - 3, nx + 6, ny - 3, nx, ny + 4, NOSE);
  face.fillCircle(nx - 4, ny - 2, 2, NOSE);
  face.fillCircle(nx + 4, ny - 2, 2, NOSE);
  tft.drawRGBBitmap(FX, FY, face.getBuffer(), FW, FH);
}

void goToSleep(float v) {
  Serial.print("low battery "); Serial.print(v, 2); Serial.println("V: sleepy eyes, screen off");
  lookX = lookY = 0;
  drawFace(0.0f);  // closed eyes
  delay(1500);
  tft.fillScreen(BG);
  tft.sleepPanel();
  asleep = true;
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(10);
  randomSeed(analogRead(PIN_BAT) ^ micros());
  tft.begin();
  tft.fillScreen(BG);
  drawFace(1.0f);
  float v = readBattery();
  Serial.print("battery="); Serial.println(v, 2);
  Serial.println("eyes awake");
}

void loop() {
  if (asleep) { delay(1000); return; }
  unsigned long now = millis();

  // Battery check every 5 s
  if (now - lastBat > 5000) {
    lastBat = now;
    float v = readBattery();
    Serial.print("battery="); Serial.println(v, 2);
    if (v < LOW_BATTERY_V) { goToSleep(v); return; }
  }

  // Pick a new place to look now and then (often back to centre)
  if (now >= nextLook) {
    if (random(3) == 0) { targetX = 0; targetY = 0; }
    else { targetX = random(-22, 23); targetY = random(-12, 13); }
    nextLook = now + random(900, 2800);
    Serial.print("look x="); Serial.print((int)targetX);
    Serial.print(" y="); Serial.println((int)targetY);
  }

  // Blink every 2-5 s, sometimes twice
  if (!blinking && now >= nextBlink) {
    blinking = true; blinkStart = now;
    Serial.println("blink");
  }
  float open = 1.0f;
  if (blinking) {
    float t = (now - blinkStart) / (float)BLINK_MS;   // 0..1 close then open
    if (t >= 1.0f) {
      blinking = false;
      if (!doubleBlink && random(4) == 0) { doubleBlink = true; nextBlink = now + 120; }
      else { doubleBlink = false; nextBlink = now + random(2000, 5000); }
    } else {
      open = fabs(1.0f - 2.0f * t);
    }
  }

  // Ease the gaze toward the target (quick dart, soft stop)
  lookX += (targetX - lookX) * 0.35f;
  lookY += (targetY - lookY) * 0.35f;

  if (now - lastFrame >= 33) {  // ~30 fps
    lastFrame = now;
    drawFace(open);
  }
}
