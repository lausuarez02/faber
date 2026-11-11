// Blink + hello on the hardware UART (Serial1, nRF52840 UARTE0). Serial on the Nano 33 BLE is USB CDC.
const int BTN = 2; // D2 = P1.11
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(BTN, INPUT_PULLUP);
  Serial1.begin(115200);
  Serial1.println("hello from nano33ble");
}
int n = 0;
void loop() {
  digitalWrite(LED_BUILTIN, n & 1);
  Serial1.print("tick "); Serial1.print(n); Serial1.print(" ms="); Serial1.print(millis());
  Serial1.print(" btn="); Serial1.println(digitalRead(BTN));
  n++;
  delay(100);
}
