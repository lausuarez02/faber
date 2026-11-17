// Faber reference firmware: a tamagotchi-style pixel pet.
//
// Hardware (see ../../faber.json): Arduino Uno, SSD1306 128x64 OLED on I2C (0x3C, SDA = A4,
// SCL = A5), three push buttons to GND on D2 (feed), D3 (play), D4 (sleep) using INPUT_PULLUP,
// and an active buzzer on D8.
//
// The pet has three stats, 0..100, higher is better: food, happy, energy. Every second awake:
// food -2, happy -1, energy -1. Asleep: energy +4, food -1. Feed: food +25. Play: happy +20,
// energy -10, food -5 (refused below 15 energy). Sleep toggles sleeping. Any stat under 20 makes
// the pet sad, and it beeps an alarm every 5 seconds. A status line goes out on Serial every
// second, so tests (and you) can follow it:  t=12 food=78 happy=79 energy=79 mood=happy sleeping=0
//
// Without a display the pet still runs (serial only) and says so.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const uint8_t PIN_FEED = 2;
const uint8_t PIN_PLAY = 3;
const uint8_t PIN_SLEEP = 4;
const uint8_t PIN_BUZZER = 8;
const uint8_t OLED_ADDR = 0x3C;

Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool haveDisplay = false;

int food = 80, happy = 80, energy = 80;
bool sleeping = false;
unsigned long lastTick = 0, lastFrame = 0, lastAlarm = 0, beepUntil = 0;
unsigned int seconds = 0;
uint8_t frame = 0;

// 16x16 pet sprites, 1 bit per pixel, MSB left (drawn at 2x).
const uint8_t PROGMEM PET_HAPPY[] = {
  0x07, 0xE0, 0x18, 0x18, 0x20, 0x04, 0x40, 0x02, 0x4C, 0x32, 0x8C, 0x31, 0x80, 0x01, 0x80, 0x01,
  0x88, 0x11, 0x84, 0x21, 0x43, 0xC2, 0x40, 0x02, 0x20, 0x04, 0x18, 0x18, 0x07, 0xE0, 0x00, 0x00};
const uint8_t PROGMEM PET_BLINK[] = {
  0x07, 0xE0, 0x18, 0x18, 0x20, 0x04, 0x40, 0x02, 0x40, 0x02, 0x9E, 0x79, 0x80, 0x01, 0x80, 0x01,
  0x88, 0x11, 0x84, 0x21, 0x43, 0xC2, 0x40, 0x02, 0x20, 0x04, 0x18, 0x18, 0x07, 0xE0, 0x00, 0x00};
const uint8_t PROGMEM PET_SAD[] = {
  0x07, 0xE0, 0x18, 0x18, 0x20, 0x04, 0x40, 0x02, 0x4C, 0x32, 0x8C, 0x31, 0x80, 0x01, 0x80, 0x01,
  0x83, 0xC1, 0x84, 0x21, 0x48, 0x12, 0x40, 0x02, 0x20, 0x04, 0x18, 0x18, 0x07, 0xE0, 0x00, 0x00};
const uint8_t PROGMEM PET_SLEEP[] = {
  0x07, 0xE0, 0x18, 0x18, 0x20, 0x04, 0x40, 0x02, 0x40, 0x02, 0x9E, 0x79, 0x80, 0x01, 0x80, 0x01,
  0x80, 0x01, 0x83, 0xC1, 0x40, 0x02, 0x40, 0x02, 0x20, 0x04, 0x18, 0x18, 0x07, 0xE0, 0x00, 0x00};

struct Button {
  uint8_t pin;
  bool last;
  unsigned long changed;
};
Button buttons[3] = {{PIN_FEED, true, 0}, {PIN_PLAY, true, 0}, {PIN_SLEEP, true, 0}};

int clampStat(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

bool sad() { return food < 20 || happy < 20 || energy < 20; }

const __FlashStringHelper *mood() {
  if (sleeping) return F("asleep");
  return sad() ? F("sad") : F("happy");
}

void beep(unsigned int ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  beepUntil = millis() + ms;
}

void printStatus() {
  Serial.print(F("t="));
  Serial.print(seconds);
  Serial.print(F(" food="));
  Serial.print(food);
  Serial.print(F(" happy="));
  Serial.print(happy);
  Serial.print(F(" energy="));
  Serial.print(energy);
  Serial.print(F(" mood="));
  Serial.print(mood());
  Serial.print(F(" sleeping="));
  Serial.println(sleeping ? 1 : 0);
}

void drawBar(int x, char label, int value) {
  display.setCursor(x, 0);
  display.print(label);
  display.drawRect(x + 8, 1, 30, 6, SSD1306_WHITE);
  display.fillRect(x + 9, 2, (value * 28) / 100, 4, SSD1306_WHITE);
}

void drawSprite(const uint8_t *bmp, int x0, int y0) {
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      uint8_t b = pgm_read_byte(bmp + y * 2 + (x >> 3));
      if (b & (0x80 >> (x & 7))) display.fillRect(x0 + x * 2, y0 + y * 2, 2, 2, SSD1306_WHITE);
    }
  }
}

void render() {
  if (!haveDisplay) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  drawBar(0, 'F', food);
  drawBar(43, 'H', happy);
  drawBar(86, 'E', energy);
  // Idle animation: bounce one pixel every half second, blink every 8th frame.
  int bounce = (frame & 1) ? 1 : 0;
  const uint8_t *sprite = PET_HAPPY;
  if (sleeping) sprite = PET_SLEEP;
  else if (sad()) sprite = PET_SAD;
  else if ((frame & 7) == 7) sprite = PET_BLINK;
  drawSprite(sprite, 48, 14 + (sleeping ? 2 : bounce));
  if (sleeping) {
    display.setCursor(84, 16 + (frame & 3));
    display.print(F("z Z"));
  }
  display.setCursor(0, 56);
  if (sleeping) display.print(F("sleeping..."));
  else if (sad()) display.print(F("I need you!"));
  else display.print(F("feed  play  sleep"));
  display.display();
}

void onPress(uint8_t pin) {
  if (pin == PIN_SLEEP) {
    sleeping = !sleeping;
    Serial.println(sleeping ? F("sleep") : F("wake"));
    if (haveDisplay) display.ssd1306_command(SSD1306_SETCONTRAST), display.ssd1306_command(sleeping ? 0x10 : 0xCF);
    beep(30);
  } else if (sleeping) {
    Serial.println(F("shh, sleeping"));
  } else if (pin == PIN_FEED) {
    if (food > 90) {
      happy = clampStat(happy - 5);
      Serial.println(F("not hungry"));
    } else {
      food = clampStat(food + 25);
      Serial.print(F("feed food="));
      Serial.println(food);
    }
    beep(60);
  } else if (pin == PIN_PLAY) {
    if (energy < 15) {
      Serial.println(F("too tired"));
      beep(200);
    } else {
      happy = clampStat(happy + 20);
      energy = clampStat(energy - 10);
      food = clampStat(food - 5);
      Serial.print(F("play happy="));
      Serial.println(happy);
      beep(120);
    }
  }
  render();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_FEED, INPUT_PULLUP);
  pinMode(PIN_PLAY, INPUT_PULLUP);
  pinMode(PIN_SLEEP, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  Wire.begin();
  Wire.beginTransmission(OLED_ADDR);
  if (Wire.endTransmission() == 0 && display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    haveDisplay = true;
  } else {
    Serial.println(F("OLED not found at 0x3C, running headless"));
  }
  Serial.println(F("Pet hatched"));
  render();
  beep(100);
}

void loop() {
  unsigned long now = millis();

  for (uint8_t i = 0; i < 3; i++) {
    bool level = digitalRead(buttons[i].pin);
    if (level != buttons[i].last && now - buttons[i].changed > 30) {
      buttons[i].changed = now;
      buttons[i].last = level;
      if (level == LOW) onPress(buttons[i].pin);
    }
  }

  if (beepUntil && (long)(now - beepUntil) >= 0) {
    digitalWrite(PIN_BUZZER, LOW);
    beepUntil = 0;
  }

  if (now - lastTick >= 1000) {
    lastTick += 1000;
    seconds++;
    if (sleeping) {
      energy = clampStat(energy + 4);
      food = clampStat(food - 1);
      if (energy >= 100) {
        sleeping = false;
        Serial.println(F("wake"));
        if (haveDisplay) display.ssd1306_command(SSD1306_SETCONTRAST), display.ssd1306_command(0xCF);
      }
    } else {
      food = clampStat(food - 2);
      happy = clampStat(happy - 1);
      energy = clampStat(energy - 1);
    }
    printStatus();
    if (!sleeping && sad() && now - lastAlarm >= 5000) {
      lastAlarm = now;
      Serial.println(F("beep: needs care"));
      beep(300);
    }
  }

  if (now - lastFrame >= 500) {
    lastFrame += 500;
    frame++;
    render();
  }
}
