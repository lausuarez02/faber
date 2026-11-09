// Explorer Bot: wanders an arena on its own, dodges obstacles with an HC-SR04,
// and shows its mood on an SSD1306 OLED (happy while cruising, surprised when dodging).
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---- Pins ----
const int ENA = 5, IN1 = 7, IN2 = 8;   // left motor  (L298N channel A)
const int ENB = 6, IN3 = 2, IN4 = 3;   // right motor (L298N channel B)
const int TRIG = 9, ECHO = 10;         // HC-SR04

// ---- Tuning ----
const int CRUISE_SPEED   = 170;  // PWM 0..255
const int TURN_SPEED     = 160;
const int DODGE_CM       = 40;   // closer than this -> dodge (a corner at the body's edge
                                 // only enters the ±15° beam beyond ~28 cm, so leave room)
const int CLEAR_CM       = 70;   // spin until the way ahead is this open
const int WEAVE          = 35;   // left/right speed bias that sweeps the narrow beam
const unsigned long WEAVE_MS    = 400;
const unsigned long BACKUP_MS   = 250;
const unsigned long MIN_SPIN_MS = 250;
const unsigned long MAX_SPIN_MS = 2500;
const unsigned long PING_MS     = 50;

Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool haveDisplay = false;

enum State { CRUISE, BACKUP, SPIN };
State state = CRUISE;
unsigned long stateStart = 0, lastPing = 0, extraSpin = 0;
int spinDir = 1;          // +1 = spin left, -1 = spin right
int distCm = 400;
unsigned long dodges = 0;

enum Face { FACE_NONE, FACE_HAPPY, FACE_SURPRISED };
Face face = FACE_NONE;

// ---- Motors ----
void motor(int en, int a, int b, int speed) {   // -255..255
  speed = constrain(speed, -255, 255);
  digitalWrite(a, speed > 0 ? HIGH : LOW);
  digitalWrite(b, speed < 0 ? HIGH : LOW);
  analogWrite(en, abs(speed));
}
void drive(int left, int right) {
  motor(ENA, IN1, IN2, left);
  motor(ENB, IN3, IN4, right);
}

// ---- Sonar ----
int readCm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 25000UL);
  if (us == 0) return 400;            // no echo: nothing in range
  return (int)(us / 58);
}

// ---- Face ----
void drawHappy() {
  display.clearDisplay();
  // big smile first (its trimming rectangle must not erase the eyes)
  display.fillCircle(64, 38, 18, SSD1306_WHITE);
  display.fillCircle(64, 32, 18, SSD1306_BLACK);
  display.fillRect(40, 14, 48, 24, SSD1306_BLACK);
  // eyes on top: happy arcs (upside-down U, like ^ ^)
  display.fillCircle(40, 24, 10, SSD1306_WHITE);
  display.fillCircle(40, 28, 9, SSD1306_BLACK);
  display.fillRect(29, 26, 23, 10, SSD1306_BLACK);
  display.fillCircle(88, 24, 10, SSD1306_WHITE);
  display.fillCircle(88, 28, 9, SSD1306_BLACK);
  display.fillRect(77, 26, 23, 10, SSD1306_BLACK);
}
void drawSurprised() {
  display.clearDisplay();
  // wide round eyes with pupils
  display.fillCircle(40, 22, 12, SSD1306_WHITE);
  display.fillCircle(40, 22, 4, SSD1306_BLACK);
  display.fillCircle(88, 22, 12, SSD1306_WHITE);
  display.fillCircle(88, 22, 4, SSD1306_BLACK);
  // raised eyebrows
  display.drawLine(28, 5, 50, 3, SSD1306_WHITE);
  display.drawLine(78, 3, 100, 5, SSD1306_WHITE);
  // "O" mouth
  display.fillCircle(64, 50, 9, SSD1306_WHITE);
  display.fillCircle(64, 50, 5, SSD1306_BLACK);
}
void setFace(Face f) {
  if (f == face) return;              // redraw only on change: keeps the loop fast
  face = f;
  if (haveDisplay) {
    if (f == FACE_HAPPY) drawHappy(); else drawSurprised();
    display.display();
  }
  Serial.print(F("face="));
  Serial.println(f == FACE_HAPPY ? F("happy") : F("surprised"));
}

void enter(State s) {
  state = s;
  stateStart = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  drive(0, 0);

  Wire.begin();
  Wire.beginTransmission(0x3C);
  if (Wire.endTransmission() == 0 && display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    haveDisplay = true;
  } else {
    Serial.println(F("OLED not found at 0x3C: exploring without a face"));
  }
  randomSeed(analogRead(A0));
  setFace(FACE_HAPPY);
  Serial.println(F("Explorer Bot ready: cruising"));
  enter(CRUISE);
}

void loop() {
  unsigned long now = millis();
  if (now - lastPing >= PING_MS) {
    lastPing = now;
    distCm = readCm();
  }

  switch (state) {
    case CRUISE: {
      // Weave gently so the narrow sonar beam sweeps left and right of the path.
      int bias = ((now / WEAVE_MS) % 2) ? WEAVE : -WEAVE;
      drive(CRUISE_SPEED + bias, CRUISE_SPEED - bias);
      if (distCm < DODGE_CM) {
        dodges++;
        spinDir = random(2) ? 1 : -1;
        extraSpin = random(0, 400);
        Serial.print(F("dodge #")); Serial.print(dodges);
        Serial.print(F(" dist=")); Serial.print(distCm);
        Serial.println(spinDir > 0 ? F(" turning left") : F(" turning right"));
        setFace(FACE_SURPRISED);
        enter(BACKUP);
      }
      break;
    }

    case BACKUP:
      drive(-TURN_SPEED, -TURN_SPEED);
      if (now - stateStart >= BACKUP_MS) enter(SPIN);
      break;

    case SPIN: {
      drive(-spinDir * TURN_SPEED, spinDir * TURN_SPEED);
      unsigned long t = now - stateStart;
      bool open = distCm >= CLEAR_CM && t >= MIN_SPIN_MS + extraSpin;
      if (open || t >= MAX_SPIN_MS) {
        Serial.print(F("clear dist=")); Serial.println(distCm);
        setFace(FACE_HAPPY);
        enter(CRUISE);
      }
      break;
    }
  }
}
