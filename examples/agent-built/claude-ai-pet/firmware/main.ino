// Pip, a tamagotchi with an AI brain.
// Uno + ILI9341 320x240 TFT (SPI) + ESP-01 (AT firmware, SoftwareSerial D2/D3)
// + buttons TALK D4 / FEED D5 / PLAY D6 (to GND, INPUT_PULLUP) + active buzzer D7.
#include <SPI.h>
#include <SoftwareSerial.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define PIN_TALK 4
#define PIN_FEED 5
#define PIN_PLAY 6
#define PIN_BUZZ 7

const unsigned long TICK_MS = 2000;      // stats decay period
const unsigned long NAG_MS = 8000;       // attention beep period while hungry/sad
const unsigned long RETRY_MS = 5000;     // Wi-Fi rejoin period while offline
const unsigned long SPEAK_MS = 10000;    // how long a speech bubble stays

Adafruit_ILI9341 tft(10, 9, 8);  // CS, DC, RST
SoftwareSerial esp(2, 3);        // RX (ESP TX via 1k), TX (ESP RX via 1k/2k divider)

enum Mood : int8_t { M_HAPPY, M_OK, M_HUNGRY, M_SAD, M_SLEEPY, M_NONE = -1 };
const char n0[] PROGMEM = "happy";
const char n1[] PROGMEM = "ok";
const char n2[] PROGMEM = "hungry";
const char n3[] PROGMEM = "sad";
const char n4[] PROGMEM = "sleepy";
const char *const moodNames[] PROGMEM = {n0, n1, n2, n3, n4};
const uint16_t moodColor[] = {ILI9341_YELLOW, ILI9341_GREENYELLOW, ILI9341_ORANGE, 0x5D1F, 0xB59F};

int food = 80, joy = 70, energy = 80;
bool online = false, statusDirty = true, wasOnline = false;
int8_t shownMood = M_NONE, aiMood = M_NONE;
unsigned long nextTick, nextNag, nextRetry, speakUntil = 0;
bool bubbleUp = false;
uint8_t retries = 0;

// ---------- buzzer (non-blocking) ----------
uint8_t beepsLeft = 0;
bool beepOn = false;
unsigned long beepAt = 0;
uint16_t beepOnMs, beepOffMs;
void beep(uint8_t n, uint16_t onMs, uint16_t offMs) {
  beepsLeft = n; beepOnMs = onMs; beepOffMs = offMs; beepOn = false; beepAt = millis();
}
void updateBeep() {
  if (!beepsLeft && !beepOn) return;
  if ((long)(millis() - beepAt) < 0) return;
  if (beepOn) { digitalWrite(PIN_BUZZ, LOW); beepOn = false; beepAt = millis() + beepOffMs; }
  else if (beepsLeft) { digitalWrite(PIN_BUZZ, HIGH); beepOn = true; beepsLeft--; beepAt = millis() + beepOnMs; }
}

// ---------- ESP-01 helpers ----------
char win[20];
void winReset() { memset(win, ' ', sizeof(win) - 1); win[sizeof(win) - 1] = 0; }
void winPush(char c) {
  if (c == 0) return;
  memmove(win, win + 1, sizeof(win) - 2);
  win[sizeof(win) - 2] = c;
}
void setOnline(bool on) {
  if (on == online) return;
  online = on;
  statusDirty = true;
  Serial.println(on ? F("wifi: online") : F("wifi: offline"));
  if (!on) { retries = 0; nextRetry = millis() + RETRY_MS; }
}
// Watches the module's unsolicited messages (drops and rejoins).
void scanAsync() {
  if (strstr(win, "WIFI DISCONNECT")) { setOnline(false); winReset(); }
  else if (strstr(win, "WIFI GOT IP")) { setOnline(true); winReset(); }
}
void pumpEsp() {
  while (esp.available()) { winPush(esp.read()); scanAsync(); }
}
// Waits for token a (returns 1) or b (returns 2); 0 on timeout.
uint8_t expectAny(const char *a, const char *b, unsigned long ms) {
  winReset();
  unsigned long start = millis();
  while (millis() - start < ms) {
    updateBeep();
    while (esp.available()) {
      winPush(esp.read());
      if (strstr(win, a)) return 1;
      if (b && strstr(win, b)) return 2;
      if (strstr(win, "WIFI DISCONNECT")) { setOnline(false); return 2; }
    }
  }
  return 0;
}

void espInit() {
  esp.begin(9600);
  delay(600);
  esp.print(F("AT\r\n"));
  if (expectAny("OK", NULL, 500) != 1) {
    // factory module talks 115200: switch it to 9600 (SoftwareSerial is reliable there)
    esp.begin(115200);
    esp.print(F("AT+UART_DEF=9600,8,1,0,0\r\n"));
    delay(50);
    esp.begin(9600);
    esp.print(F("AT\r\n"));
    if (expectAny("OK", NULL, 800) != 1) { Serial.println(F("wifi: module not answering")); return; }
  }
  esp.print(F("ATE0\r\n")); expectAny("OK", NULL, 500);
  esp.print(F("AT+CWMODE=1\r\n")); expectAny("OK", NULL, 500);
  joinWifi(15000);
}

void joinWifi(unsigned long ms) {
  esp.print(F("AT+CWJAP=\"JumperNet\",\"\"\r\n"));
  uint8_t r = expectAny("OK", "FAIL", ms);
  if (r == 1) { online = false; setOnline(true); }
  else setOnline(false);
  winReset();
}

// Asks the AI. On success fills body with "mood|text" and returns true.
char body[96];
bool askBrain() {
  if (!online) return false;
  esp.print(F("AT+CIPSTART=\"TCP\",\"ai.jumper\",80\r\n"));
  if (expectAny("OK", "ERROR", 5000) != 1) return false;
  char req[100];
  int n = snprintf_P(req, sizeof(req),
                     PSTR("GET /v1/pet?a=talk&f=%d&j=%d&e=%d&n=Pip HTTP/1.0\r\nHost: ai.jumper\r\n\r\n"),
                     food, joy, energy);
  esp.print(F("AT+CIPSEND="));
  esp.print(n);
  esp.print(F("\r\n"));
  if (expectAny(">", "ERROR", 2000) != 1) return false;
  esp.print(req);

  // Parse: ... +IPD,<len>:<HTTP headers>\r\n\r\n<body> ... CLOSED
  uint8_t state = 0, crlf = 0, blen = 0;  // 0 wait +IPD, 1 skip to ':', 2 headers, 3 body, 4 skip to ':' (next chunk)
  body[0] = 0;
  winReset();
  unsigned long start = millis();
  while (millis() - start < 12000) {
    updateBeep();
    while (esp.available()) {
      char c = esp.read();
      winPush(c);
      if (strstr(win, "WIFI DISCONNECT")) { setOnline(false); return false; }
      if (state == 0) { if (strstr(win, "+IPD,")) state = 1; }
      else if (state == 1 || state == 4) { if (c == ':') state = (state == 1) ? 2 : 3; }
      else if (state == 2) {
        if (c == '\r' || c == '\n') { if (++crlf >= 4) state = 3; } else crlf = 0;
      } else if (state == 3 && blen < sizeof(body) - 1) {
        body[blen++] = c; body[blen] = 0;
        char *p = strstr(body, "+IPD,");
        if (p) { *p = 0; blen = p - body; state = 4; }
      }
      if (strstr(win, "CLOSED")) {
        char *p = strstr(body, "CLOSED");
        if (p) *p = 0;
        int L = strlen(body);
        while (L > 0 && (body[L - 1] == '\r' || body[L - 1] == '\n' || body[L - 1] == ' ')) body[--L] = 0;
        return L > 0;
      }
    }
  }
  return false;
}

// ---------- mood ----------
int8_t statsMood() {
  if (food < 30) return M_HUNGRY;
  if (joy < 30) return M_SAD;
  if (energy < 25) return M_SLEEPY;
  if (food >= 60 && joy >= 60) return M_HAPPY;
  return M_OK;
}
int8_t moodFromWord(const char *w) {
  if (!strncmp_P(w, PSTR("happy"), 5) || !strncmp_P(w, PSTR("excited"), 7) || !strncmp_P(w, PSTR("playful"), 7)) return M_HAPPY;
  if (!strncmp_P(w, PSTR("hungry"), 6)) return M_HUNGRY;
  if (!strncmp_P(w, PSTR("sad"), 3) || !strncmp_P(w, PSTR("lonely"), 6) || !strncmp_P(w, PSTR("bored"), 5)) return M_SAD;
  if (!strncmp_P(w, PSTR("sleepy"), 6) || !strncmp_P(w, PSTR("tired"), 5)) return M_SLEEPY;
  if (!strncmp_P(w, PSTR("ok"), 2) || !strncmp_P(w, PSTR("calm"), 4) || !strncmp_P(w, PSTR("neutral"), 7) || !strncmp_P(w, PSTR("content"), 7)) return M_OK;
  return M_NONE;
}
int8_t displayMood() { return (bubbleUp && aiMood != M_NONE) ? aiMood : statsMood(); }
void printMood(int8_t m) { Serial.print((const __FlashStringHelper *)pgm_read_ptr(&moodNames[m])); }
int clamp100(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

// ---------- drawing ----------
const int CX = 160, CY = 166, R = 48;
void drawFace(int8_t m) {
  uint16_t b = moodColor[m];
  tft.fillRect(100, 112, 130, 112, ILI9341_BLACK);
  tft.fillCircle(CX, CY, R, b);
  int ey = CY - 12;
  for (int s = -1; s <= 1; s += 2) {
    int ex = CX + s * 18;
    switch (m) {
      case M_HAPPY:
        tft.fillCircle(ex, ey, 8, ILI9341_BLACK);
        tft.fillCircle(ex, ey + 4, 8, b);
        tft.fillCircle(CX + s * 32, CY + 8, 6, ILI9341_PINK);
        break;
      case M_SLEEPY:
        tft.fillRect(ex - 8, ey, 16, 3, ILI9341_BLACK);
        break;
      case M_SAD:
        tft.fillCircle(ex, ey, 6, ILI9341_BLACK);
        tft.drawLine(ex - 8, ey - 10 - s * 3, ex + 8, ey - 10 + s * 3, ILI9341_BLACK);
        break;
      default:
        tft.fillCircle(ex, ey, 6, ILI9341_BLACK);
        tft.fillCircle(ex + 2, ey - 2, 2, ILI9341_WHITE);
    }
  }
  switch (m) {
    case M_HAPPY:
      tft.fillCircle(CX, CY + 12, 16, ILI9341_BLACK);
      tft.fillRect(CX - 17, CY - 5, 34, 17, b);
      tft.fillCircle(CX, CY + 22, 5, ILI9341_RED);
      break;
    case M_SAD:
      tft.fillCircle(CX, CY + 30, 14, ILI9341_BLACK);
      tft.fillCircle(CX, CY + 34, 14, b);
      tft.fillCircle(CX + 24, CY + 4, 4, ILI9341_BLUE);  // tear
      break;
    case M_HUNGRY:
      tft.fillCircle(CX, CY + 20, 11, ILI9341_BLACK);
      tft.fillCircle(CX, CY + 26, 5, ILI9341_RED);
      break;
    case M_SLEEPY:
      tft.fillCircle(CX, CY + 20, 4, ILI9341_BLACK);
      tft.setTextColor(ILI9341_WHITE);
      tft.setTextSize(2);
      tft.setCursor(CX + 44, CY - 50);
      tft.print(F("zZ"));
      break;
    default:
      tft.fillRect(CX - 12, CY + 18, 24, 4, ILI9341_BLACK);
  }
}

void drawBar(int x, const __FlashStringHelper *label, int v, uint16_t col) {
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(x, 7);
  tft.print(label);
  tft.drawRect(x + 30, 5, 52, 10, ILI9341_WHITE);
  tft.fillRect(x + 31, 6, v / 2, 8, v < 30 ? ILI9341_RED : col);
}
void drawStatus() {
  tft.fillRect(0, 0, 320, 20, ILI9341_NAVY);
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(4, 3);
  tft.print(F("Pip"));
  drawBar(48, F("FOOD"), food, ILI9341_GREEN);
  drawBar(140, F("JOY"), joy, ILI9341_YELLOW);
  tft.setTextSize(1);
  if (online) {
    tft.fillRoundRect(262, 3, 54, 14, 4, ILI9341_DARKGREEN);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(277, 7);
    tft.print(F("WiFi"));
  } else {
    tft.fillRoundRect(262, 3, 54, 14, 4, ILI9341_RED);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(268, 7);
    tft.print(F("OFFLINE"));
  }
}

void clearBubble() { tft.fillRect(0, 22, 320, 92, ILI9341_BLACK); bubbleUp = false; }
void showBubble(const char *s, uint16_t textCol) {
  tft.fillRect(0, 22, 320, 92, ILI9341_BLACK);
  tft.fillRoundRect(8, 24, 304, 80, 10, ILI9341_WHITE);
  tft.fillTriangle(140, 102, 170, 102, 152, 114, ILI9341_WHITE);
  tft.setTextSize(2);
  tft.setTextColor(textCol);
  const uint8_t maxc = 24;
  uint8_t line = 0;
  while (*s && line < 4) {
    while (*s == ' ') s++;
    uint8_t len = strlen(s), take = len;
    if (len > maxc) {
      take = maxc;
      while (take > 0 && s[take] != ' ') take--;
      if (take == 0) take = maxc;
    }
    tft.setCursor(16, 30 + line * 18);
    for (uint8_t i = 0; i < take; i++) tft.write(s[i]);
    s += take;
    line++;
  }
  bubbleUp = true;
  speakUntil = millis() + SPEAK_MS;
}
void sayP(const char *pstr, uint16_t col) {
  char buf[64];
  strncpy_P(buf, pstr, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = 0;
  showBubble(buf, col);
}

void drawLabels() {
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_LIGHTGREY);
  tft.setCursor(22, 224); tft.print(F("TALK"));
  tft.setCursor(136, 224); tft.print(F("FEED"));
  tft.setCursor(250, 224); tft.print(F("PLAY"));
}

void printStats() {
  Serial.print(F("stats food=")); Serial.print(food);
  Serial.print(F(" joy=")); Serial.print(joy);
  Serial.print(F(" energy=")); Serial.print(energy);
  Serial.print(F(" mood=")); printMood(statsMood());
  Serial.println();
}

// ---------- actions ----------
void doTalk() {
  Serial.println(F("talk: asking brain"));
  sayP(PSTR("...thinking..."), ILI9341_DARKGREY);
  beep(1, 40, 0);
  if (!askBrain()) {
    Serial.println(F("talk: no answer (offline)"));
    aiMood = M_SAD;
    sayP(PSTR("I can't reach my brain... no WiFi :("), ILI9341_RED);
    return;
  }
  Serial.print(F("brain says: "));
  Serial.println(body);
  char *bar = strchr(body, '|');
  char *text = body;
  aiMood = M_NONE;
  if (bar) { *bar = 0; aiMood = moodFromWord(body); text = bar + 1; }
  joy = clamp100(joy + 5);
  statusDirty = true;
  showBubble(text, ILI9341_BLACK);
  beep(2, 40, 60);
}
void doFeed() {
  food = clamp100(food + 30);
  Serial.print(F("fed food=")); Serial.println(food);
  aiMood = M_NONE;
  sayP(PSTR("Yum! Thank you!"), ILI9341_BLACK);
  beep(1, 80, 0);
  statusDirty = true;
}
void doPlay() {
  joy = clamp100(joy + 30);
  energy = clamp100(energy - 10);
  food = clamp100(food - 5);
  Serial.print(F("played joy=")); Serial.println(joy);
  aiMood = M_NONE;
  sayP(PSTR("Wheee! Again!"), ILI9341_BLACK);
  beep(3, 30, 40);
  statusDirty = true;
}

// Edge-detected buttons (active LOW) with 30 ms debounce.
const uint8_t btnPins[3] = {PIN_TALK, PIN_FEED, PIN_PLAY};
bool btnDown[3] = {false, false, false};
unsigned long btnChanged[3] = {0, 0, 0};
int8_t pollButtons() {
  int8_t pressed = -1;
  for (uint8_t i = 0; i < 3; i++) {
    bool d = digitalRead(btnPins[i]) == LOW;
    if (d != btnDown[i] && millis() - btnChanged[i] > 30) {
      btnDown[i] = d;
      btnChanged[i] = millis();
      if (d) pressed = i;
    }
  }
  return pressed;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TALK, INPUT_PULLUP);
  pinMode(PIN_FEED, INPUT_PULLUP);
  pinMode(PIN_PLAY, INPUT_PULLUP);
  pinMode(PIN_BUZZ, OUTPUT);
  tft.begin();
  tft.setRotation(1);
  tft.fillScreen(ILI9341_BLACK);
  drawLabels();
  online = false;
  drawStatus();
  sayP(PSTR("Hatching... connecting to WiFi"), ILI9341_DARKGREY);
  espInit();
  Serial.println(F("pet ready"));
  printStats();
  sayP(online ? PSTR("Hi! I'm Pip. Press TALK!") : PSTR("Hi! I'm Pip. No WiFi yet..."), ILI9341_BLACK);
  statusDirty = true;
  wasOnline = online;
  unsigned long now = millis();
  nextTick = now + TICK_MS;
  nextNag = now;
  nextRetry = now + RETRY_MS;
}

void loop() {
  unsigned long now = millis();
  pumpEsp();
  updateBeep();

  switch (pollButtons()) {
    case 0: doTalk(); break;
    case 1: doFeed(); break;
    case 2: doPlay(); break;
  }

  if ((long)(now - nextTick) >= 0) {
    nextTick += TICK_MS;
    food = clamp100(food - 4);
    joy = clamp100(joy - 3);
    energy = clamp100(energy + 1);
    statusDirty = true;
    printStats();
  }

  int8_t sm = statsMood();
  if ((sm == M_HUNGRY || sm == M_SAD) && (long)(millis() - nextNag) >= 0) {
    nextNag = millis() + NAG_MS;
    Serial.print(F("attention: beep ("));
    printMood(sm);
    Serial.println(')');
    beep(2, 150, 120);
  } else if (sm != M_HUNGRY && sm != M_SAD) {
    nextNag = millis();  // nag right away the next time it gets needy
  }

  if (!online && (long)(millis() - nextRetry) >= 0) {
    retries++;
    Serial.print(F("wifi: retry #")); Serial.println(retries);
    joinWifi(4000);
    nextRetry = millis() + RETRY_MS;
  }

  if (online != wasOnline) {
    wasOnline = online;
    aiMood = M_NONE;  // face follows the real stats again, not a stale AI/offline expression
    if (online) sayP(PSTR("I'm back online!"), ILI9341_DARKGREEN);
    else sayP(PSTR("WiFi lost! Retrying..."), ILI9341_RED);
  }

  if (statusDirty) { statusDirty = false; drawStatus(); }

  if (bubbleUp && (long)(millis() - speakUntil) >= 0) { clearBubble(); aiMood = M_NONE; }

  int8_t m = displayMood();
  if (m != shownMood) {
    shownMood = m;
    Serial.print(F("face=")); printMood(m); Serial.println();
    drawFace(m);
  }
}
