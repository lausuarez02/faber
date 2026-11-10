import type { Usage } from "./hints.ts";

/**
 * Round 5, track "rp2040" (owner): get_part usage hints for the pocket boards
 * (raspberry-pi-pico, seeed-xiao-rp2040, waveshare-rp2040-zero). Merged over the core table in
 * hints.ts. Decision 0003, C7.
 */
const RP2040_COMMON =
  "3.3 V logic: never put 5 V on a GPIO (use a level shifter for 5 V signals); power 3.3 V modules from 3V3 and 5 V ones from VBUS (\"5V\"). Pin ids are GPIO numbers: GP25 is pinMode(25, …). Serial is the USB port (the console); Serial1 is UART0 on its TX/RX pins. analogRead is 10-bit (0..1023) by default, analogReadResolution(12) gives 0..4095. Every GPIO can do PWM (analogWrite, 1 kHz by default) and tone().";

export const BOARDS_R5_HINTS: Record<string, Usage> = {
  "raspberry-pi-pico": {
    wiring: `${RP2040_COMMON} Raspberry Pi Pico: GP0-GP22 and GP26-GP28 on the headers; GP26/27/28 are A0/A1/A2. Wire (I2C0) is SDA GP4 / SCL GP5; SPI is MISO GP16, CS GP17, SCK GP18, MOSI GP19; Serial1 TX GP0 / RX GP1. The on-board LED is GP25 (LED_BUILTIN). Rails: 3V3 (300 mA), VBUS (USB 5 V), VSYS (~4.7 V); grounds GND.1-GND.7 and AGND ("pico.GND" picks a free one).`,
    example: `void setup() {\n  Serial.begin(115200);\n  while (!Serial && millis() < 2000) delay(10);  // native USB: wait for the port\n  pinMode(LED_BUILTIN, OUTPUT);  // GP25\n  Serial.println("hello from the Pico");\n}\nvoid loop() { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); delay(500); }`,
  },
  "seeed-xiao-rp2040": {
    wiring: `${RP2040_COMMON} XIAO RP2040: silkscreen D0-D10 map to GP26, GP27, GP28, GP29, GP6, GP7, GP0, GP1, GP2, GP4, GP3 (use D0…D10 / A0…A3 in code, or the GPIO number; wire to the GP ids, "xiao.D4" also works). Wire is SDA D4 (GP6) / SCL D5 (GP7); SPI is SCK D8 (GP2), MISO D9 (GP4), MOSI D10 (GP3), CS usually D7 (GP1); Serial1 TX D6 (GP0) / RX D7 (GP1). The user LED is RGB and active LOW: LED_BUILTIN = red GP17, green GP16, blue GP25. Rails: 3V3, 5V (USB VBUS), one GND.`,
    example: `void setup() {\n  Serial.begin(115200);\n  while (!Serial && millis() < 2000) delay(10);  // native USB: wait for the port\n  pinMode(LED_BUILTIN, OUTPUT);  // red, active low\n  pinMode(D0, OUTPUT);\n}\nvoid loop() {\n  digitalWrite(LED_BUILTIN, LOW);  // on\n  digitalWrite(D0, HIGH);\n  delay(500);\n  digitalWrite(LED_BUILTIN, HIGH);\n  digitalWrite(D0, LOW);\n  delay(500);\n}`,
  },
  "waveshare-rp2040-zero": {
    wiring: `${RP2040_COMMON} RP2040-Zero: GP0-GP15 and GP26-GP29 on the edges (GP26-GP29 are A0-A3). Wire (I2C0) is SDA GP4 / SCL GP5; SPI is SCK GP2, MOSI GP3, MISO GP4, CS GP5 (shared with Wire's defaults: use one or the other on those pins; Wire.setSDA/setSCL to other pins is not followed by the simulator); Serial1 TX GP0 / RX GP1. Its only LED is a WS2812 on GP16 (not drawn). Rails: 3V3, 5V (USB VBUS), one GND.`,
    example: `void setup() {\n  Serial.begin(115200);\n  while (!Serial && millis() < 2000) delay(10);  // native USB: wait for the port\n  pinMode(15, OUTPUT);  // an LED + 220 ohm on GP15\n}\nvoid loop() { digitalWrite(15, !digitalRead(15)); delay(500); }`,
  },
};
