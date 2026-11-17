// Faber reference firmware: an AI pet on a colour screen.
//
// Hardware (see ../../faber.json): Arduino Uno; ILI9341 2.8in 320x240 TFT on SPI (CS D10,
// DC D9, RST D8, MOSI D11, SCK D13, LED 5V); ESP-01S Wi-Fi module with AT firmware on
// SoftwareSerial (ESP TX -> D2, D3 -> 1k/2k divider -> ESP RX, VCC 3V3); buttons to GND on
// D4 (talk), D5 (feed), D6 (play) with INPUT_PULLUP; active buzzer on D7.
//
// The pet has food, joy and energy (0..100). TALK asks the pet's AI what it thinks; FEED and PLAY
// change the stats and also ask the AI for a reaction. Left alone for 30 s it asks by itself
// ("lonely"). The AI answers "<mood>|<text>" (text <= 60 chars) from
//   GET http://ai.faber/v1/pet?a=<action>&f=<food>&j=<joy>&e=<energy>&n=Pip
// and the reply is shown in a speech bubble with a matching face. Without Wi-Fi the pet shows an
// offline icon, keeps the question and asks again when the module reconnects.
//
// On real hardware: set WIFI_SSID / WIFI_PASS to your network and AI_HOST to the LAN address of
// the computer running `node services/ai-gateway/bin/ai-gateway.mjs` with AI_PORT 8787, and power the
// ESP-01 from its own 3.3 V regulator (see ../../README.md, "On a real device").
//
// Serial, 115200 baud: "Pet hatched", one status line every 2 s
//   t=12 food=64 joy=58 energy=70 mood=happy wifi=1
// and one line per event (wifi: ..., ask a=..., reply <status> <mood>|<text>, bubble: ...).
#include <SPI.h>
#include <SoftwareSerial.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define WIFI_SSID "FaberNet"
#define WIFI_PASS ""
#define AI_HOST "ai.faber"
#define AI_PORT 80  // the gateway on a real computer listens on 8787
#define PET_NAME "Pip"
#define STR2(x) #x
#define STR(x) STR2(x)

const uint8_t PIN_TALK = 4, PIN_FEED = 5, PIN_PLAY = 6, PIN_BUZZER = 7;

Adafruit_ILI9341 tft(10, 9, 8);
SoftwareSerial esp(2, 3);  // RX, TX

// ------------------------------------------------------------------ colours (RGB565)
const uint16_t C_BAR = 0x10A4, C_INK = 0x18C3, C_WHITE = 0xFFFF, C_BODY = 0x3EB6, C_BODY_D = 0x2D0F,
               C_BELLY = 0xAFBC, C_CHEEK = 0xFB56, C_TONGUE = 0xF9CF, C_GROUND = 0x1B26, C_GRASS = 0x2C68,
               C_FOOD = 0xFC60, C_JOY = 0xF8B2, C_ENERGY = 0xAFE5, C_GREY = 0x7BEF, C_RED = 0xF800,
               C_AMBER = 0xFD20, C_ONLINE = 0x5FE9, C_TEAR = 0x5D1F;
// Sky bands, top to bottom (y 30..213, 23 px each).
const uint16_t SKY[8] = {0x2129, 0x214B, 0x298D, 0x31AF, 0x39F1, 0x4233, 0x4A75, 0x52B6};
const int16_t SKY_TOP = 30, SKY_BAND = 23, GROUND_Y = 214;
const int16_t PET_X = 160, PET_Y = 166;

enum Mood : uint8_t { HAPPY, HUNGRY, SLEEPY, SAD, EXCITED };
const char MOOD_NAMES[] PROGMEM = "happy\0hungry\0sleepy\0sad\0excited\0";

// ------------------------------------------------------------------ pet state
int food = 70, joy = 70, energy = 80;
Mood shownMood = HAPPY;
bool eyesClosed = false;
unsigned long lastTick = 0, lastInteraction = 0, lastLonely = 0, nextBlink = 3000, blinkUntil = 0, beepUntil = 0,
              bubbleUntil = 0, lastStatus = 0;
unsigned int seconds = 0;
Mood replyMood = HAPPY;
bool replyMoodActive = false;

// ------------------------------------------------------------------ Wi-Fi / AT state
enum WifiState : uint8_t { W_BOOT, W_CONNECTING, W_ONLINE, W_OFFLINE };
WifiState wifi = W_BOOT;
WifiState drawnWifi = W_OFFLINE;
char win[24];             // rolling window of what the module said
uint8_t flags = 0;        // tokens seen since the last command
const uint8_t F_OK = 1, F_ERR = 2, F_PROMPT = 4, F_SENDOK = 8, F_IPD = 16, F_CLOSED = 32;
enum Job : uint8_t { J_NONE, J_JOIN, J_ASK };
Job job = J_NONE;
uint8_t step = 0;
unsigned long stepStart = 0, stepTimeout = 0, retryAt = 0;
char pendingAction[8] = "";  // a question waiting to be asked
char askAction[8] = "";
// +IPD payload parsing
bool inPayload = false;
int ipdLeft = 0, ipdLenAcc = -1;
uint8_t hdrMatch = 0, statusDigits = 0;
bool inBody = false;
int httpStatus = 0;
char reply[64];
uint8_t replyLen = 0;

// ------------------------------------------------------------------ helpers
int clampStat(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

Mood statMood() {
  if (food < 30) return HUNGRY;
  if (energy < 25) return SLEEPY;
  if (joy < 30) return SAD;
  if (joy > 85 && energy > 50) return EXCITED;
  return HAPPY;
}

void printMood(Mood m) {
  const char *p = MOOD_NAMES;
  for (uint8_t i = 0; i < m; i++) p += strlen_P(p) + 1;
  Serial.print((const __FlashStringHelper *)p);
}

Mood parseMood(const char *s, uint8_t n) {
  const char *p = MOOD_NAMES;
  for (uint8_t i = 0; i < 5; i++) {
    uint8_t l = strlen_P(p);
    if (l == n && strncmp_P(s, p, n) == 0) return (Mood)i;
    p += l + 1;
  }
  return statMood();
}

void beep(unsigned int ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  beepUntil = millis() + ms;
}

// ------------------------------------------------------------------ drawing
uint16_t skyAt(int16_t y) {
  int16_t b = (y - SKY_TOP) / SKY_BAND;
  return SKY[b < 0 ? 0 : (b > 7 ? 7 : b)];
}

// Repaint the sky inside a rectangle (band by band), to erase something drawn on it.
void drawSky(int16_t x, int16_t y, int16_t w, int16_t h) {
  int16_t y1 = y + h;
  if (y < SKY_TOP) y = SKY_TOP;
  if (y1 > GROUND_Y) y1 = GROUND_Y;
  while (y < y1) {
    int16_t bandEnd = SKY_TOP + ((y - SKY_TOP) / SKY_BAND + 1) * SKY_BAND;
    if (bandEnd > y1) bandEnd = y1;
    tft.fillRect(x, y, w, bandEnd - y, skyAt(y));
    y = bandEnd;
  }
}

void drawBar(int16_t x, const __FlashStringHelper *label, int value, uint16_t color) {
  tft.setTextSize(1);
  tft.setTextColor(C_WHITE, C_BAR);
  tft.setCursor(x, 4);
  tft.print(label);
  tft.drawRoundRect(x, 15, 74, 10, 3, C_GREY);
  int16_t w = (int32_t)value * 70 / 100;
  tft.fillRect(x + 2, 17, w, 6, color);
  tft.fillRect(x + 2 + w, 17, 70 - w, 6, C_BAR);
}

void drawStats() {
  drawBar(6, F("FOOD"), food, C_FOOD);
  drawBar(92, F("JOY"), joy, C_JOY);
  drawBar(178, F("ENERGY"), energy, C_ENERGY);
}

void drawWifiIcon() {
  const int16_t x = 300, y = 24;
  tft.fillRect(280, 0, 40, 30, C_BAR);
  uint16_t c = wifi == W_ONLINE ? C_ONLINE : (wifi == W_OFFLINE ? C_GREY : C_AMBER);
  // drawCircleHelper writes pixels without selecting the chip: wrap it in a transaction.
  tft.startWrite();
  for (int16_t r = 6; r <= 18; r += 6) {
    tft.drawCircleHelper(x, y, r, 1 | 2, c);
    tft.drawCircleHelper(x, y, r - 1, 1 | 2, c);
  }
  tft.endWrite();
  tft.fillCircle(x, y, 2, c);
  if (wifi == W_OFFLINE) {
    for (int8_t d = -1; d <= 1; d++) {
      tft.drawLine(286 + d, 6, 300 + d, 20, C_RED);
      tft.drawLine(300 + d, 6, 286 + d, 20, C_RED);
    }
  }
  drawnWifi = wifi;
  Serial.print(F("icon: "));
  Serial.println(wifi == W_ONLINE ? F("online") : (wifi == W_OFFLINE ? F("offline") : F("connecting")));
}

void drawEye(int16_t x, int16_t y, Mood m, bool closed) {
  tft.fillCircle(x, y, 10, C_BODY);  // erase
  if (closed || m == SLEEPY) {
    tft.fillRoundRect(x - 9, y - 1, 18, 4, 2, C_INK);
    return;
  }
  tft.fillCircle(x, y, 9, C_WHITE);
  int16_t pr = m == EXCITED ? 6 : 5;
  int16_t py = m == SAD ? y + 3 : y + 1;
  tft.fillCircle(x + 1, py, pr, C_INK);
  tft.fillCircle(x + 3, py - 2, 2, C_WHITE);
  if (m == EXCITED) tft.fillCircle(x - 2, py + 2, 1, C_WHITE);
}

void drawEyes(Mood m, bool closed) {
  drawEye(PET_X - 17, PET_Y - 14, m, closed);
  drawEye(PET_X + 17, PET_Y - 14, m, closed);
}

void drawMouth(Mood m) {
  const int16_t x = PET_X, y = PET_Y + 14;
  tft.fillRect(x - 15, y - 9, 30, 26, C_BELLY);  // erase (inside the belly)
  switch (m) {
    case HAPPY:
      tft.fillCircle(x, y - 2, 10, C_INK);
      tft.fillRect(x - 11, y - 13, 23, 11, C_BELLY);
      tft.fillCircle(x, y + 4, 4, C_TONGUE);
      break;
    case EXCITED:
      tft.fillCircle(x, y + 2, 11, C_INK);
      tft.fillCircle(x, y + 7, 6, C_TONGUE);
      break;
    case HUNGRY:
      tft.fillCircle(x, y + 2, 6, C_INK);
      tft.fillCircle(x + 9, y + 10, 3, C_TEAR);
      break;
    case SAD:
      tft.fillCircle(x, y + 12, 10, C_INK);
      tft.fillCircle(x, y + 12, 7, C_BELLY);
      tft.fillRect(x - 11, y + 12, 23, 11, C_BELLY);
      break;
    case SLEEPY:
      tft.fillRoundRect(x - 7, y + 2, 14, 4, 2, C_INK);
      break;
  }
}

void drawExtras(Mood m) {
  // tear / zzz / sparkles next to the head (erased first)
  drawSky(PET_X + 40, PET_Y - 66, 44, 40);
  drawSky(PET_X - 70, PET_Y - 30, 20, 30);
  if (m == SLEEPY) {
    tft.setTextSize(2);
    tft.setTextColor(C_WHITE);
    tft.setCursor(PET_X + 48, PET_Y - 50);
    tft.print('z');
    tft.setTextSize(1);
    tft.setCursor(PET_X + 66, PET_Y - 62);
    tft.print('z');
  } else if (m == SAD) {
    tft.fillCircle(PET_X - 62, PET_Y - 10, 4, C_TEAR);
    tft.fillTriangle(PET_X - 66, PET_Y - 11, PET_X - 58, PET_Y - 11, PET_X - 62, PET_Y - 20, C_TEAR);
  } else if (m == EXCITED) {
    tft.fillTriangle(PET_X + 56, PET_Y - 60, PET_X + 52, PET_Y - 48, PET_X + 60, PET_Y - 48, C_AMBER);
    tft.fillTriangle(PET_X + 56, PET_Y - 40, PET_X + 52, PET_Y - 52, PET_X + 60, PET_Y - 52, C_AMBER);
  }
}

void drawPet(Mood m) {
  tft.drawLine(PET_X, PET_Y - 46, PET_X + 8, PET_Y - 60, C_BODY_D);
  tft.drawLine(PET_X + 1, PET_Y - 46, PET_X + 9, PET_Y - 60, C_BODY_D);
  tft.fillCircle(PET_X + 9, PET_Y - 62, 5, C_JOY);
  tft.fillRoundRect(PET_X - 34, PET_Y + 36, 22, 12, 6, C_BODY_D);
  tft.fillRoundRect(PET_X + 12, PET_Y + 36, 22, 12, 6, C_BODY_D);
  tft.fillCircle(PET_X, PET_Y, 46, C_BODY);
  tft.fillCircle(PET_X, PET_Y + 20, 24, C_BELLY);
  tft.fillCircle(PET_X - 31, PET_Y + 2, 6, C_CHEEK);
  tft.fillCircle(PET_X + 31, PET_Y + 2, 6, C_CHEEK);
  drawEyes(m, false);
  drawMouth(m);
  drawExtras(m);
}

// Change the face with a blink in between, so expressions do not just snap.
void setMood(Mood m) {
  if (m == shownMood) return;
  drawEyes(shownMood, true);
  delay(60);
  drawMouth(m);
  drawExtras(m);
  drawEyes(m, false);
  shownMood = m;
  Serial.print(F("face: "));
  printMood(m);
  Serial.println();
}

void drawGround() {
  tft.fillRect(0, GROUND_Y, 320, 240 - GROUND_Y, C_GROUND);
  tft.fillRect(0, GROUND_Y, 320, 3, C_GRASS);
  tft.setTextSize(1);
  tft.setTextColor(C_WHITE, C_GROUND);
  tft.setCursor(40, 224);
  tft.print(F("[TALK]"));
  tft.setCursor(140, 224);
  tft.print(F("[FEED]"));
  tft.setCursor(240, 224);
  tft.print(F("[PLAY]"));
}

void eraseBubble() {
  drawSky(6, 30, 308, 64);   // the box
  drawSky(186, 94, 34, 18);  // the tail
}

void clearBubble() {
  eraseBubble();
  bubbleUntil = 0;
  drawPet(shownMood);  // the tail may have touched the antenna
}

// A white speech bubble with the text word-wrapped in up to 3 lines of 24 characters.
void showBubble(const char *text) {
  eraseBubble();
  tft.fillRoundRect(8, 32, 304, 62, 10, C_WHITE);
  tft.fillTriangle(196, 92, 216, 92, 190, 108, C_WHITE);
  tft.setTextSize(2);
  tft.setTextColor(C_INK, C_WHITE);
  int16_t y = 38;
  const char *p = text;
  for (uint8_t line = 0; line < 3 && *p; line++) {
    while (*p == ' ') p++;
    uint8_t n = strlen(p);
    if (n > 24) {
      n = 24;
      while (n > 0 && p[n] != ' ') n--;
      if (n == 0) n = 24;
    }
    tft.setCursor(16, y);
    for (uint8_t i = 0; i < n; i++) tft.print(p[i]);
    p += n;
    y += 18;
  }
  bubbleUntil = millis() + 7000;
  Serial.print(F("bubble: "));
  Serial.println(text);
}

// ------------------------------------------------------------------ ESP-01 (AT firmware)
void winClear() {
  memset(win, ' ', sizeof(win) - 1);
  win[sizeof(win) - 1] = 0;
}

bool winHas(const char *tokenP) { return strstr_P(win, tokenP) != NULL; }

void espLine(const __FlashStringHelper *s) {
  winClear();
  flags = 0;
  esp.print(s);
  esp.print(F("\r\n"));
}

void startPayload() {
  inPayload = true;
  ipdLeft = 0;
  ipdLenAcc = 0;
  hdrMatch = 0;
  statusDigits = 0;
  httpStatus = 0;
  inBody = false;
  replyLen = 0;
}

// Bytes of the +IPD payload: "HTTP/1.0 200 OK\r\n...\r\n\r\n<mood>|<text>"
void payloadChar(char c) {
  if (ipdLenAcc >= 0) {  // still reading "<len>:"
    if (c == ':') {
      ipdLeft = ipdLenAcc;
      ipdLenAcc = -1;
    } else if (c >= '0' && c <= '9') ipdLenAcc = ipdLenAcc * 10 + (c - '0');
    return;
  }
  if (inBody) {
    if (replyLen < sizeof(reply) - 1 && c >= 32 && c < 127) reply[replyLen++] = c;
  } else {
    if (statusDigits < 12) {  // "HTTP/1.0 200": digits at offsets 9..11
      if (statusDigits >= 9 && c >= '0' && c <= '9') httpStatus = httpStatus * 10 + (c - '0');
      statusDigits++;
    }
    const char seq[] = "\r\n\r\n";
    hdrMatch = (c == seq[hdrMatch]) ? hdrMatch + 1 : (c == '\r' ? 1 : 0);
    if (hdrMatch == 4) inBody = true;
  }
  if (--ipdLeft <= 0) {
    inPayload = false;
    reply[replyLen] = 0;
    flags |= F_IPD;
  }
}

void espChar(char c) {
  if (inPayload) {
    payloadChar(c);
    return;
  }
  memmove(win, win + 1, sizeof(win) - 2);
  win[sizeof(win) - 2] = c;
  if (c == '\n' || c == '>' || c == ',' || c == ' ') {
    if (winHas(PSTR("WIFI DISCONNECT"))) {
      if (wifi != W_OFFLINE) Serial.println(F("wifi: offline (module lost the AP)"));
      wifi = W_OFFLINE;
      if (!retryAt) retryAt = millis() + 15000;  // the module reconnects by itself; rejoin if it has not by then
      winClear();
    } else if (winHas(PSTR("WIFI GOT IP"))) {
      if (wifi != W_ONLINE) Serial.println(F("wifi: online"));
      wifi = W_ONLINE;
      winClear();
    } else if (winHas(PSTR("SEND OK\r\n"))) {
      flags |= F_SENDOK;
      winClear();
    } else if (winHas(PSTR("OK\r\n"))) {
      flags |= F_OK;
      winClear();
    } else if (winHas(PSTR("ERROR\r\n")) || winHas(PSTR("FAIL\r\n"))) {
      flags |= F_ERR;
      winClear();
    } else if (winHas(PSTR("CLOSED\r\n"))) {
      flags |= F_CLOSED;
      winClear();
    } else if (c == '>') {
      flags |= F_PROMPT;
    } else if (winHas(PSTR("+IPD,"))) {
      winClear();
      startPayload();
    }
  }
}

void pollEsp() {
  while (esp.available()) espChar((char)esp.read());
}

void nextStep(uint8_t s, unsigned long timeout) {
  step = s;
  stepStart = millis();
  stepTimeout = timeout;
}

bool stepTimedOut() { return millis() - stepStart > stepTimeout; }

void startJoin() {
  job = J_JOIN;
  if (wifi != W_ONLINE) wifi = W_CONNECTING;
  Serial.println(F("wifi: connecting"));
  // A factory-new module talks at 115200, which SoftwareSerial cannot receive reliably: try
  // 9600 first, else switch the module to 9600 (saved in its flash) and continue.
  esp.begin(9600);
  espLine(F("AT"));
  nextStep(0, 600);
}

void runJoin() {
  switch (step) {
    case 0:
      if (flags & F_OK) {
        espLine(F("ATE0"));
        nextStep(3, 600);
      } else if (stepTimedOut()) {
        Serial.println(F("wifi: module at 115200, setting it to 9600"));
        esp.begin(115200);
        esp.print(F("AT+UART_DEF=9600,8,1,0,0\r\n"));
        nextStep(1, 60);
      }
      break;
    case 1:
      if (stepTimedOut()) {
        esp.begin(9600);
        espLine(F("AT"));
        nextStep(2, 800);
      }
      break;
    case 2:
      if (flags & F_OK) {
        espLine(F("ATE0"));
        nextStep(3, 600);
      } else if (stepTimedOut()) {
        Serial.println(F("wifi: ESP-01 not answering (check TX/RX and 3.3 V power)"));
        job = J_NONE;
        wifi = W_OFFLINE;
        retryAt = millis() + 10000;
      }
      break;
    case 3:
      if ((flags & F_OK) || stepTimedOut()) {
        espLine(F("AT+CWMODE=1"));
        nextStep(4, 800);
      }
      break;
    case 4:
      if ((flags & F_OK) || stepTimedOut()) {
        espLine(F("AT+CWJAP=\"" WIFI_SSID "\",\"" WIFI_PASS "\""));
        nextStep(5, 20000);
      }
      break;
    case 5:
      if (flags & F_OK) {
        if (wifi != W_ONLINE) Serial.println(F("wifi: online"));
        wifi = W_ONLINE;
        job = J_NONE;
      } else if ((flags & F_ERR) || stepTimedOut()) {
        Serial.println(F("wifi: join failed, retry in 10 s"));
        wifi = W_OFFLINE;
        job = J_NONE;
        retryAt = millis() + 10000;
      }
      break;
  }
}

void askDone(bool ok) {
  job = J_NONE;
  if (!ok) {
    Serial.print(F("ai: no answer for a="));
    Serial.print(askAction);
    Serial.println(F(", will retry when online"));
    strcpy(pendingAction, askAction);
    retryAt = millis() + 8000;
    showBubble(wifi == W_ONLINE ? "Hmm? I could not hear my cloud..." : "No Wi-Fi... I will ask later");
    return;
  }
  Serial.print(F("reply "));
  Serial.print(httpStatus);
  Serial.print(' ');
  Serial.println(reply);
  const char *bar = strchr(reply, '|');
  if (bar) {
    replyMood = parseMood(reply, bar - reply);
    replyMoodActive = true;
    setMood(replyMood);
    showBubble(bar + 1);
  } else {
    showBubble(reply);
  }
  beep(40);
}

void startAsk(const char *action) {
  strncpy(askAction, action, sizeof(askAction) - 1);
  askAction[sizeof(askAction) - 1] = 0;
  pendingAction[0] = 0;
  Serial.print(F("ask a="));
  Serial.print(askAction);
  Serial.print(F(" f="));
  Serial.print(food);
  Serial.print(F(" j="));
  Serial.print(joy);
  Serial.print(F(" e="));
  Serial.println(energy);
  if (wifi != W_ONLINE) {
    askDone(false);
    return;
  }
  showBubble("...");
  job = J_ASK;
  espLine(F("AT+CIPSTART=\"TCP\",\"" AI_HOST "\"," STR(AI_PORT)));
  nextStep(0, 6000);
}

uint8_t requestText(char *buf, uint8_t size) {
  return snprintf_P(buf, size, PSTR("GET /v1/pet?a=%s&f=%d&j=%d&e=%d&n=" PET_NAME " HTTP/1.0\r\nHost: " AI_HOST "\r\n\r\n"), askAction, food, joy, energy);
}

void runAsk() {
  switch (step) {
    case 0:  // CIPSTART
      if (flags & F_OK) {
        char buf[100];
        uint8_t n = requestText(buf, sizeof(buf));
        winClear();
        flags = 0;
        esp.print(F("AT+CIPSEND="));
        esp.print(n);
        esp.print(F("\r\n"));
        nextStep(1, 3000);
      } else if ((flags & (F_ERR | F_CLOSED)) || stepTimedOut()) {
        askDone(false);
      }
      break;
    case 1:  // waiting for the > prompt
      if (flags & F_PROMPT) {
        char buf[100];
        requestText(buf, sizeof(buf));
        flags = 0;
        esp.print(buf);
        nextStep(2, 4000);
      } else if ((flags & F_ERR) || stepTimedOut()) {
        askDone(false);
      }
      break;
    case 2:  // SEND OK, then the answer (a live AI can take several seconds)
      if (flags & F_IPD) {
        nextStep(3, 1500);
      } else if ((flags & (F_ERR | F_CLOSED)) || stepTimedOut()) {
        askDone(false);
      } else if ((flags & F_SENDOK) && stepTimeout < 25000) {
        nextStep(2, 25000);
      }
      break;
    case 3:  // the server closes after the answer
      if ((flags & F_CLOSED) || stepTimedOut()) askDone(httpStatus > 0 && replyLen > 0);
      break;
  }
}

// ------------------------------------------------------------------ buttons
struct Button {
  uint8_t pin;
  bool last;
  unsigned long changed;
};
Button buttons[3] = {{PIN_TALK, true, 0}, {PIN_FEED, true, 0}, {PIN_PLAY, true, 0}};

void ask(const char *action) {
  if (job == J_ASK) return;  // one question at a time
  if (job == J_NONE) startAsk(action);
  else strcpy(pendingAction, action);  // joining: ask when online
}

void onPress(uint8_t i) {
  lastInteraction = millis();
  beep(30);
  if (i == 0) {
    Serial.println(F("talk"));
    ask("talk");
  } else if (i == 1) {
    food = clampStat(food + 25);
    Serial.print(F("feed food="));
    Serial.println(food);
    drawStats();
    ask("feed");
  } else {
    joy = clampStat(joy + 20);
    energy = clampStat(energy - 10);
    Serial.print(F("play joy="));
    Serial.print(joy);
    Serial.print(F(" energy="));
    Serial.println(energy);
    drawStats();
    ask("play");
  }
}

void readButtons() {
  for (uint8_t i = 0; i < 3; i++) {
    bool level = digitalRead(buttons[i].pin);
    if (level != buttons[i].last && millis() - buttons[i].changed > 30) {
      buttons[i].last = level;
      buttons[i].changed = millis();
      if (!level) onPress(i);
    }
  }
}

// ------------------------------------------------------------------ main
void printStatus() {
  Serial.print(F("t="));
  Serial.print(seconds);
  Serial.print(F(" food="));
  Serial.print(food);
  Serial.print(F(" joy="));
  Serial.print(joy);
  Serial.print(F(" energy="));
  Serial.print(energy);
  Serial.print(F(" mood="));
  printMood(statMood());
  Serial.print(F(" wifi="));
  Serial.println(wifi == W_ONLINE ? 1 : 0);
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TALK, INPUT_PULLUP);
  pinMode(PIN_FEED, INPUT_PULLUP);
  pinMode(PIN_PLAY, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  tft.begin();
  tft.setRotation(1);
  tft.fillRect(0, 0, 320, SKY_TOP, C_BAR);
  drawSky(0, SKY_TOP, 320, GROUND_Y - SKY_TOP);
  drawGround();
  drawStats();
  drawPet(shownMood);
  wifi = W_CONNECTING;
  drawWifiIcon();
  Serial.println(F("Pet hatched"));
  winClear();
  delay(500);  // the ESP-01 boots for ~400 ms (and prints at 74880 baud meanwhile)
  while (esp.available()) esp.read();
  startJoin();
  lastInteraction = millis();
}

void loop() {
  unsigned long now = millis();
  pollEsp();
  if (job == J_JOIN) runJoin();
  else if (job == J_ASK) runAsk();
  pollEsp();

  if (job == J_NONE) {
    if (wifi != W_ONLINE && retryAt && now >= retryAt) {
      retryAt = 0;
      Serial.println(F("wifi: retry"));
      startJoin();
    } else if (pendingAction[0] && wifi == W_ONLINE && (!retryAt || now >= retryAt)) {
      retryAt = 0;
      char a[8];
      strcpy(a, pendingAction);
      startAsk(a);
    }
  }
  if (wifi != drawnWifi) drawWifiIcon();
  readButtons();

  if (beepUntil && now >= beepUntil) {
    digitalWrite(PIN_BUZZER, LOW);
    beepUntil = 0;
  }
  // Every 2 s: stats decay and a status line.
  if (now - lastTick >= 2000) {
    lastTick += 2000;
    seconds += 2;
    food = clampStat(food - 1);
    joy = clampStat(joy - 1);
    if (seconds % 4 == 0) energy = clampStat(energy - 1);
    drawStats();
    printStatus();
  }
  // Lonely: no button for 30 s, then at most once a minute.
  if (job == J_NONE && wifi == W_ONLINE && !pendingAction[0] && now - lastInteraction > 30000 && (lastLonely == 0 || now - lastLonely > 60000)) {
    lastLonely = now;
    ask("lonely");
  }
  // Speech bubble timeout, then the face follows the stats again.
  if (bubbleUntil && now >= bubbleUntil && job != J_ASK) {
    clearBubble();
    replyMoodActive = false;
  }
  if (!replyMoodActive && !bubbleUntil) setMood(statMood());
  // Blink every few seconds.
  if (!eyesClosed && now >= nextBlink && shownMood != SLEEPY) {
    drawEyes(shownMood, true);
    eyesClosed = true;
    blinkUntil = now + 140;
  } else if (eyesClosed && now >= blinkUntil) {
    drawEyes(shownMood, false);
    eyesClosed = false;
    nextBlink = now + 2600 + (seconds % 3) * 700;
  }
}
