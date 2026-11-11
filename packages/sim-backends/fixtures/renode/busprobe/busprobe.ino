// Renode board fixture: the buses and peripherals a sketch uses, through Jumper's bridge.
//   Wire     scan (prints "i2c 0x<addr>"), then each loop writes register 0x00 to 0x48 and reads 2 bytes
//   SPI      CS on the board's SS pin LOW, transfer 0x9F 0x00, CS HIGH; prints the two MISO bytes
//   ADC      analogRead on the board's first analog pin (12-bit where the core allows)
//   PWM      analogWrite(<PWM pin>, 64): about 25 % duty
//   IRQ      attachInterrupt(<IRQ pin>, FALLING) counts presses
//   Serial   echoes what it receives as "rx <line>"
#include <Wire.h>
#include <SPI.h>

#if defined(ARDUINO_BLUEPILL_F103C8) || defined(ARDUINO_BLACKPILL_F411CE)
#define CONSOLE Serial
#define ADC_PIN PA0
#define PWM_PIN PB8
#define IRQ_PIN PB12
#define CS_PIN PA4
#elif defined(ARDUINO_NUCLEO_F401RE)
#define CONSOLE Serial
#define ADC_PIN PA0
#define PWM_PIN PB10
#define IRQ_PIN PA8
#define CS_PIN PB6
#elif defined(ARDUINO_ARDUINO_NANO33BLE)
#define CONSOLE Serial1
#define ADC_PIN A0
#define PWM_PIN D9
#define IRQ_PIN D2
#define CS_PIN D10
#elif defined(ARDUINO_Seeed_XIAO_nRF52840)
#define CONSOLE Serial1
#define ADC_PIN A0
#define PWM_PIN D2
#define IRQ_PIN D3
#define CS_PIN D7
#endif

volatile unsigned presses = 0;
void onPress() { presses++; }
String line;

void setup() {
  CONSOLE.begin(115200);
  Wire.begin();
  SPI.begin();
  pinMode(CS_PIN, OUTPUT);
  digitalWrite(CS_PIN, HIGH);
  pinMode(IRQ_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(IRQ_PIN), onPress, FALLING);
#if defined(ARDUINO_ARCH_STM32)
  analogReadResolution(12);
#elif defined(ARDUINO_ARCH_NRF52) || defined(ARDUINO_ARCH_MBED)
  analogReadResolution(12);
#endif
  analogWrite(PWM_PIN, 64);
  for (uint8_t a = 8; a < 120; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      CONSOLE.print("i2c 0x");
      CONSOLE.println(a, HEX);
    }
  }
  CONSOLE.println("bus up");
}

void loop() {
  Wire.beginTransmission(0x48);
  Wire.write(0x00);
  int err = Wire.endTransmission(false);
  int got = Wire.requestFrom(0x48, 2);
  int hi = Wire.read(), lo = Wire.read();
  digitalWrite(CS_PIN, LOW);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  int s0 = SPI.transfer(0x9F);
  int s1 = SPI.transfer(0x00);
  SPI.endTransaction();
  digitalWrite(CS_PIN, HIGH);
  int adc = analogRead(ADC_PIN);
  CONSOLE.print("i2c_err="); CONSOLE.print(err);
  CONSOLE.print(" got="); CONSOLE.print(got);
  CONSOLE.print(" raw=0x"); CONSOLE.print((hi << 8) | lo, HEX);
  CONSOLE.print(" spi="); CONSOLE.print(s0, HEX); CONSOLE.print(","); CONSOLE.print(s1, HEX);
  CONSOLE.print(" adc="); CONSOLE.print(adc);
  CONSOLE.print(" presses="); CONSOLE.println(presses);
  while (CONSOLE.available()) {
    char c = CONSOLE.read();
    if (c == '\n') { CONSOLE.print("rx "); CONSOLE.println(line); line = ""; }
    else line += c;
  }
  delay(20);
}
