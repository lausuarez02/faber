// L298N example: motor A forward at half speed, full speed, brake, then reverse.
// Wiring: ENA -> D5 (PWM), IN1 -> D7, IN2 -> D8, OUT1/OUT2 -> motor,
//         battery + -> 12V, battery - -> GND, L298N GND -> Arduino GND.
const int ENA = 5, IN1 = 7, IN2 = 8;

void motor(int speed) {          // -255..255
  digitalWrite(IN1, speed > 0 ? HIGH : LOW);
  digitalWrite(IN2, speed < 0 ? HIGH : LOW);
  analogWrite(ENA, abs(speed));
}

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  Serial.println("forward 50%");  motor(128);  delay(1000);
  Serial.println("forward 100%"); motor(255);  delay(1000);
  Serial.println("brake");        digitalWrite(IN1, LOW); digitalWrite(IN2, LOW); analogWrite(ENA, 255); delay(500);
  Serial.println("reverse 75%");  motor(-191); delay(1000);
  Serial.println("coast");        motor(0);    delay(500);
}
