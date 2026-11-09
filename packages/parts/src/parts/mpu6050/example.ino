// MPU-6050 (GY-521) with Adafruit_MPU6050 (Uno: SDA = A4, SCL = A5, VCC = 5V).
// Prints acceleration (m/s^2), rotation (rad/s) and temperature every 200 ms.
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  if (!mpu.begin(0x68)) {
    Serial.println(F("MPU6050 not found at 0x68: check wiring"));
    for (;;) {}
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  Serial.println(F("MPU6050 ready"));
}

void loop() {
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  Serial.print(F("a "));
  Serial.print(a.acceleration.x, 2); Serial.print(' ');
  Serial.print(a.acceleration.y, 2); Serial.print(' ');
  Serial.print(a.acceleration.z, 2);
  Serial.print(F(" g "));
  Serial.print(g.gyro.x, 3); Serial.print(' ');
  Serial.print(g.gyro.y, 3); Serial.print(' ');
  Serial.print(g.gyro.z, 3);
  Serial.print(F(" t "));
  Serial.println(t.temperature, 1);
  delay(200);
}
