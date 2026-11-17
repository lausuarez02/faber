// Obstacle-avoiding 2WD rover for Fabwright (examples/rover).
//
// Parts: Arduino Uno, L298N dual H-bridge, two TT gear motors, HC-SR04 sonar, 4xAA pack.
//   L298N  ENA <- D5 (PWM)  IN1 <- D7  IN2 <- D8   -> left motor  (OUT1/OUT2)
//          ENB <- D6 (PWM)  IN3 <- D4  IN4 <- D2   -> right motor (OUT3/OUT4)
//   HC-SR04 TRIG <- D9, ECHO -> D10
//
// Behaviour: drive forward while the way is clear. When something is closer than STOP_CM,
// stop, back up a little, then turn right in short steps until the sonar sees open space.
// Prints one line per decision on Serial (115200 baud).

const int ENA = 5, IN1 = 7, IN2 = 8;   // left motor
const int ENB = 6, IN3 = 4, IN4 = 2;   // right motor
const int TRIG = 9, ECHO = 10;

const int CRUISE = 170;      // PWM 0..255 while driving forward
const int TURN = 150;        // PWM while turning in place
const long STOP_CM = 28;     // closer than this: avoid
const long CLEAR_CM = 55;    // turn until at least this much space ahead

// One HC-SR04 measurement in cm; 999 when nothing echoes within 30 ms (> ~5 m or no target).
long distanceCm() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 30000UL);
  if (us == 0) return 999;
  return us / 58;
}

// left/right: -255..255, sign = direction.
void drive(int left, int right) {
  digitalWrite(IN1, left >= 0 ? HIGH : LOW);
  digitalWrite(IN2, left >= 0 ? LOW : HIGH);
  analogWrite(ENA, abs(left));
  digitalWrite(IN3, right >= 0 ? HIGH : LOW);
  digitalWrite(IN4, right >= 0 ? LOW : HIGH);
  analogWrite(ENB, abs(right));
}

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  Serial.begin(115200);
  Serial.println("rover ready");
  drive(0, 0);
  delay(200);
}

void loop() {
  long d = distanceCm();
  if (d >= STOP_CM) {
    drive(CRUISE, CRUISE);
    delay(30);
    return;
  }
  Serial.print("obstacle ");
  Serial.print(d);
  Serial.println(" cm: avoid");
  drive(0, 0);
  delay(80);
  drive(-CRUISE, -CRUISE);
  delay(220);
  drive(0, 0);
  delay(40);
  int steps = 0;
  do {
    drive(TURN, -TURN);
    delay(90);
    drive(0, 0);
    delay(40);
    steps++;
  } while (distanceCm() < CLEAR_CM && steps < 40);
  Serial.print("clear after ");
  Serial.print(steps);
  Serial.println(" turn steps");
}
