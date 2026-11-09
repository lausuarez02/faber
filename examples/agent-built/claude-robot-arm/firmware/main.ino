// 2-servo robot arm: pots steer the joints live, REC stores poses, PLAY replays them.
// Wiring: shoulder servo D9, elbow servo D10, pots on A0/A1, REC button D2, PLAY button D3 (to GND).
#include <Servo.h>

const uint8_t PIN_SHOULDER = 9, PIN_ELBOW = 10;
const uint8_t PIN_POT_S = A0, PIN_POT_E = A1;
const uint8_t PIN_REC = 2, PIN_PLAY = 3;

const uint8_t MAX_POSES = 10;
const unsigned long DEBOUNCE_MS = 30;
const unsigned long STEP_MS = 10;    // playback: 1 degree per joint every 10 ms
const unsigned long HOLD_MS = 500;   // playback: pause at each pose

Servo shoulder, elbow;
uint8_t poseS[MAX_POSES], poseE[MAX_POSES];
uint8_t poseCount = 0;

int curS = -1, curE = -1;            // angles currently commanded

enum Mode { LIVE, PLAYING };
Mode mode = LIVE;
uint8_t playIdx = 0;
bool holding = false;
unsigned long lastStep = 0, holdStart = 0;

struct Button {
  uint8_t pin;
  bool stable;          // debounced level (true = released, pull-up)
  bool lastRaw;
  unsigned long changedAt;
};
Button recBtn = {PIN_REC, true, true, 0};
Button playBtn = {PIN_PLAY, true, true, 0};

// Returns true once per press (falling edge after debounce).
bool pressed(Button &b) {
  bool raw = digitalRead(b.pin);
  unsigned long now = millis();
  if (raw != b.lastRaw) { b.lastRaw = raw; b.changedAt = now; }
  if (raw != b.stable && now - b.changedAt >= DEBOUNCE_MS) {
    b.stable = raw;
    return raw == LOW;
  }
  return false;
}

int potAngle(uint8_t pin) {
  return map(analogRead(pin), 0, 1023, 0, 180);
}

void moveTo(int s, int e) {
  if (s != curS) { curS = s; shoulder.write(s); }
  if (e != curE) { curE = e; elbow.write(e); }
}

void printPose(const char *tag, int i, int s, int e) {
  Serial.print(tag); Serial.print(' '); Serial.print(i);
  Serial.print(" s="); Serial.print(s);
  Serial.print(" e="); Serial.println(e);
}

void updateLive() {
  int s = potAngle(PIN_POT_S), e = potAngle(PIN_POT_E);
  // 1-degree deadband so analog noise does not make the servos twitch
  if (abs(s - curS) > 1 || abs(e - curE) > 1) {
    moveTo(s, e);
    Serial.print("LIVE s="); Serial.print(curS);
    Serial.print(" e="); Serial.println(curE);
  }
}

int stepToward(int cur, int target) {
  if (cur < target) return cur + 1;
  if (cur > target) return cur - 1;
  return cur;
}

void updatePlayback() {
  unsigned long now = millis();
  if (holding) {
    if (now - holdStart < HOLD_MS) return;
    holding = false;
    playIdx++;
    if (playIdx >= poseCount) {
      Serial.println("PLAY done");
      mode = LIVE;
      curS = curE = -100;            // force the knobs to take over again
      return;
    }
  }
  if (now - lastStep < STEP_MS) return;
  lastStep = now;
  int ts = poseS[playIdx], te = poseE[playIdx];
  moveTo(stepToward(curS, ts), stepToward(curE, te));
  if (curS == ts && curE == te) {
    printPose("AT", playIdx + 1, curS, curE);
    holding = true;
    holdStart = now;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_REC, INPUT_PULLUP);
  pinMode(PIN_PLAY, INPUT_PULLUP);
  shoulder.attach(PIN_SHOULDER);
  elbow.attach(PIN_ELBOW);
  moveTo(potAngle(PIN_POT_S), potAngle(PIN_POT_E));
  Serial.print("ARM ready s="); Serial.print(curS);
  Serial.print(" e="); Serial.println(curE);
}

void loop() {
  bool rec = pressed(recBtn);
  bool play = pressed(playBtn);

  if (mode == LIVE) {
    updateLive();
    if (rec) {
      if (poseCount < MAX_POSES) {
        poseS[poseCount] = curS;
        poseE[poseCount] = curE;
        poseCount++;
        printPose("REC", poseCount, curS, curE);
      } else {
        Serial.println("REC full");
      }
    }
    if (play) {
      if (poseCount == 0) {
        Serial.println("PLAY empty");
      } else {
        Serial.print("PLAY start n="); Serial.println(poseCount);
        mode = PLAYING;
        playIdx = 0;
        holding = false;
        lastStep = millis();
      }
    }
  } else {
    if (rec) Serial.println("REC ignored (playing)");
    if (play) {
      Serial.println("PLAY stopped");
      mode = LIVE;
      curS = curE = -100;
    }
    if (mode == PLAYING) updatePlayback();
  }
}
