// RV-3028 RTC with plain Wire (no library): Uno SDA = A4, SCL = A5, VCC = 5V (or 3V3).
// On first power (PORF set) it sets the time, turns on the backup switchover (as shipped the
// coin cell is not used) and stores that in the chip's EEPROM. Prints the time every second.
#include <Wire.h>

const uint8_t RV3028 = 0x52;

uint8_t bcd(uint8_t v) { return ((v / 10) << 4) | (v % 10); }
uint8_t dec(uint8_t v) { return (v >> 4) * 10 + (v & 0x0F); }

uint8_t readReg(uint8_t reg) {
  Wire.beginTransmission(RV3028);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(RV3028, (uint8_t)1);
  return Wire.read();
}

void writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(RV3028);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

void setTime(uint16_t year, uint8_t month, uint8_t day, uint8_t hour, uint8_t minute, uint8_t second) {
  Wire.beginTransmission(RV3028);  // seconds .. year in one access, like the datasheet asks
  Wire.write(0x00);
  Wire.write(bcd(second));
  Wire.write(bcd(minute));
  Wire.write(bcd(hour));
  Wire.write(0);  // weekday 0..6, yours to assign
  Wire.write(bcd(day));
  Wire.write(bcd(month));
  Wire.write(bcd(year - 2000));
  Wire.endTransmission();
}

void enableBackup() {
  uint8_t cfg = readReg(0x37);
  cfg = (cfg & ~0x0C) | 0x0C;  // BSM = 11: level switching mode
  cfg &= ~0x20;                // TCE = 0: never trickle-charge a primary cell
  writeReg(0x37, cfg);
  writeReg(0x27, 0x00);        // EECMD: 0x00 then 0x11 = store the configuration in EEPROM
  writeReg(0x27, 0x11);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.beginTransmission(RV3028);
  if (Wire.endTransmission() != 0) {
    Serial.println(F("RV-3028 not found at 0x52: check wiring"));
    for (;;) {}
  }
  if (readReg(0x0E) & 0x01) {  // PORF: the chip lost power, the time is wrong
    Serial.println(F("RTC lost power, setting the time"));
    setTime(2030, 5, 4, 3, 2, 1);
    enableBackup();
    writeReg(0x0E, readReg(0x0E) & ~0x01);
  }
}

void loop() {
  Wire.beginTransmission(RV3028);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(RV3028, (uint8_t)7);
  uint8_t s = dec(Wire.read() & 0x7F), m = dec(Wire.read() & 0x7F), h = dec(Wire.read() & 0x3F);
  Wire.read();  // weekday
  uint8_t d = dec(Wire.read() & 0x3F), mo = dec(Wire.read() & 0x1F);
  uint16_t y = 2000 + dec(Wire.read());
  char buf[24];
  snprintf(buf, sizeof buf, "%04u-%02u-%02u %02u:%02u:%02u", y, mo, d, h, m, s);
  Serial.println(buf);
  delay(1000);
}
