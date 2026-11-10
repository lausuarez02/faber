// Round 6 (decision 0004, R1): mechanical + sourcing data appended to every shipped part.json.
// Part frame: looking at the top face like visual.svg; origin top-left of dimensions_mm; x along w,
// y DOWN along h, z up from the body bottom. Parts whose visual.svg is drawn turned a quarter
// (aspect h:w, e.g. the XIAO drawn portrait) still use dimensions_mm here: svg top = part -x.
// sourcing: only facts we are sure of; LCSC / JLC numbers are left out until checked on lcsc.com.
const usbc = (face, x, y, z, extra = {}) => ({ id: "usb", kind: "connector", face, x, y, z, w: 9.0, h: 3.3, connector: "usb-c", plug_clearance_mm: 1.5, ...extra });
export const DATA = {
  "arduino-uno": {
    mechanical: { pcb_mm: 1.6, keepout_top_mm: 6, keepout_bottom_mm: 2, mounting_holes: [{ x: 13.97, y: 50.8, d: 3.2 }, { x: 15.24, y: 2.54, d: 3.2 }, { x: 66.04, y: 45.72, d: 3.2 }, { x: 66.04, y: 17.78, d: 3.2 }],
      features: [
        { id: "usb", kind: "connector", face: "-x", x: 0, y: 15.24, z: 7.1, w: 12.2, h: 11, connector: "usb-b", plug_clearance_mm: 1.0, protrude_mm: 6.3 },
        { id: "dc-jack", kind: "connector", face: "-x", x: 0, y: 44.5, z: 7.1, w: 9, h: 11, connector: "dc-barrel-5.5x2.1", plug_clearance_mm: 1.0, protrude_mm: 1.8 },
        { id: "reset", kind: "button", face: "+z", x: 4.8, y: 3.8, shape: "round", d: 3, travel_mm: 0.25, expose: false, description: "reset button; set expose true to get a plunger" },
        { id: "led-l", kind: "led", face: "+z", x: 18.5, y: 9.5, shape: "round", d: 1.6, expose: false } ],
      source: "Arduino Uno Rev3 drawing (hole positions), connectors typical" },
    sourcing: { mpn: "A000066", manufacturer: "Arduino", package: "board 68.6 x 53.4 mm", generic: "Arduino Uno R3 compatible board (ATmega328P, USB-B, 5 V)" } },
  "arduino-nano": {
    mechanical: { pcb_mm: 1.6, keepout_top_mm: 2, keepout_bottom_mm: 1.5, mounting_holes: [{ x: 1.6, y: 1.6, d: 1.8 }, { x: 43.4, y: 1.6, d: 1.8 }, { x: 1.6, y: 16.4, d: 1.8 }, { x: 43.4, y: 16.4, d: 1.8 }],
      features: [ { id: "usb", kind: "connector", face: "-x", x: 0, y: 9, z: 3.6, w: 7.7, h: 4, connector: "mini-usb", plug_clearance_mm: 1.5, protrude_mm: 1.5 },
        { id: "reset", kind: "button", face: "+z", x: 39, y: 9, shape: "round", d: 3, travel_mm: 0.25, expose: false } ],
      source: "Arduino Nano 3.x drawing, connector typical" },
    sourcing: { mpn: "A000005", manufacturer: "Arduino", package: "board 45 x 18 mm, 0.6 in DIP-30", generic: "Arduino Nano 3.x compatible board (ATmega328P, 5 V)" } },
  "seeed-xiao-rp2040": {
    mechanical: { pcb_mm: 1.0, keepout_top_mm: 1.5, keepout_bottom_mm: 0.5,
      features: [ usbc("-x", 0, 8.75, 1.9, { h: 3.2, protrude_mm: 1.0 }),
        { id: "rgb-led", kind: "led", face: "+z", x: 3.8, y: 13.7, shape: "round", d: 1.6, expose: false, description: "user RGB LED; set expose true for a light pipe" },
        { id: "boot", kind: "button", face: "+z", x: 3.2, y: 4.0, shape: "round", d: 1.5, travel_mm: 0.2, expose: false },
        { id: "reset", kind: "button", face: "+z", x: 3.2, y: 13.5, shape: "round", d: 1.5, travel_mm: 0.2, expose: false } ],
      source: "Seeed XIAO RP2040 drawing (21 x 17.5 mm), USB-C typical" },
    sourcing: { mpn: "102010428", manufacturer: "Seeed Studio", package: "module 21 x 17.5 mm, castellated", generic: "Seeed XIAO RP2040 (RP2040, USB-C, castellated pads)" } },
  "raspberry-pi-pico": {
    mechanical: { pcb_mm: 1.0, keepout_top_mm: 1.5, keepout_bottom_mm: 0.5, mounting_holes: [{ x: 4.8, y: 2.0, d: 2.1 }, { x: 16.2, y: 2.0, d: 2.1 }, { x: 4.8, y: 49.0, d: 2.1 }, { x: 16.2, y: 49.0, d: 2.1 }],
      features: [ { id: "usb", kind: "connector", face: "-y", x: 10.5, y: 0, z: 2.5, w: 8, h: 3, connector: "micro-usb", plug_clearance_mm: 1.5, protrude_mm: 1.3 },
        { id: "bootsel", kind: "button", face: "+z", x: 10.5, y: 7.8, shape: "round", d: 3, travel_mm: 0.25, expose: false },
        { id: "led", kind: "led", face: "+z", x: 14.2, y: 5.1, shape: "round", d: 1.6, expose: false } ],
      source: "Raspberry Pi Pico datasheet (mechanical drawing)" },
    sourcing: { mpn: "SC0915", manufacturer: "Raspberry Pi", package: "module 21 x 51 mm, castellated", generic: "Raspberry Pi Pico (RP2040, micro-USB)" } },
  "waveshare-rp2040-zero": {
    mechanical: { pcb_mm: 1.0, keepout_top_mm: 1.5, keepout_bottom_mm: 0.5,
      features: [ usbc("-x", 0, 9, 2.4, { h: 3.2, protrude_mm: 0.6 }),
        { id: "rgb-led", kind: "led", face: "+z", x: 4.5, y: 4.4, shape: "rect", w: 1.6, h: 1.6, expose: false } ],
      source: "Waveshare RP2040-Zero drawing (23.5 x 18 mm), USB-C typical" },
    sourcing: { mpn: "RP2040-Zero", manufacturer: "Waveshare", package: "module 23.5 x 18 mm, castellated", generic: "Waveshare RP2040-Zero (RP2040, USB-C, castellated)" } },
  "gc9a01-round-tft": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 1.5, outline_parts: [{ shape: "round", x: 18, y: 23.2, d: 35.4 }, { shape: "rect", x: 5.7, y: 0.6, w: 24.6, h: 7.3 }],
      features: [ { id: "active-area", kind: "screen", face: "+z", x: 18, y: 23.2, shape: "round", d: 32.4, bezel_mm: 1.2 } ],
      source: "typical module: 1.28 in round IPS, 35.4 mm round PCB with a header tab" },
    sourcing: { manufacturer: "GalaxyCore (driver IC)", package: "module, 35.4 mm round PCB + 7-pin header tab", generic: "1.28 in round IPS TFT 240x240, GC9A01 driver, SPI, 3.3 V, module" } },
  "ssd1306-oled-i2c": {
    mechanical: { pcb_mm: 1.2, keepout_bottom_mm: 2.5, mounting_holes: [{ x: 1.75, y: 1.75, d: 2 }, { x: 25.25, y: 1.75, d: 2 }, { x: 1.75, y: 26.05, d: 2 }, { x: 25.25, y: 26.05, d: 2 }],
      features: [ { id: "active-area", kind: "screen", face: "+z", x: 13.5, y: 13.9, w: 21.7, h: 10.9, bezel_mm: 1.0 } ],
      source: "typical 0.96 in module (active area 21.74 x 10.86 mm)" },
    sourcing: { mpn: "SSD1306", manufacturer: "Solomon Systech (driver IC)", package: "module 27 x 27 mm, 4-pin header", generic: "0.96 in OLED 128x64, SSD1306, I2C, 4-pin module" } },
  "ili9341-tft": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 3, mounting_holes: [{ x: 2.8, y: 2.8, d: 3 }, { x: 83.2, y: 2.8, d: 3 }, { x: 2.8, y: 47.2, d: 3 }, { x: 83.2, y: 47.2, d: 3 }],
      features: [ { id: "active-area", kind: "screen", face: "+z", x: 41, y: 25, w: 57.6, h: 43.2, bezel_mm: 1.5 } ],
      source: "typical 2.8 in SPI module (active area 57.6 x 43.2 mm)" },
    sourcing: { mpn: "ILI9341", manufacturer: "Ilitek (driver IC)", package: "module 86 x 50 mm, 9-pin header", generic: "2.8 in TFT 320x240, ILI9341, SPI, module" } },
  "st7735-tft": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 3, mounting_holes: [{ x: 2.2, y: 2.2, d: 2.5 }, { x: 31.8, y: 2.2, d: 2.5 }, { x: 2.2, y: 53.8, d: 2.5 }, { x: 31.8, y: 53.8, d: 2.5 }],
      features: [ { id: "active-area", kind: "screen", face: "+z", x: 17, y: 26, w: 28.0, h: 35.0, bezel_mm: 1.0 } ],
      source: "typical 1.8 in module (active area 28 x 35 mm)" },
    sourcing: { mpn: "ST7735S", manufacturer: "Sitronix (driver IC)", package: "module 34 x 56 mm, 8-pin header", generic: "1.8 in TFT 128x160, ST7735, SPI, module" } },
  "lcd1602-i2c": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 1, mounting_holes: [{ x: 2.5, y: 2.5, d: 3 }, { x: 77.5, y: 2.5, d: 3 }, { x: 2.5, y: 33.5, d: 3 }, { x: 77.5, y: 33.5, d: 3 }],
      features: [ { id: "active-area", kind: "screen", face: "+z", x: 40, y: 18, w: 64.5, h: 14.5, bezel_mm: 2 } ],
      source: "typical 1602 module (viewing area 64.5 x 14.5 mm)" },
    sourcing: { manufacturer: "generic", package: "module 80 x 36 mm with PCF8574 I2C backpack", generic: "LCD 16x2 character display with I2C backpack (PCF8574), 5 V" } },
  "esp01-wifi": {
    mechanical: { pcb_mm: 1.0, keepout_bottom_mm: 1,
      features: [ { id: "antenna", kind: "antenna", face: "+z", x: 4, y: 7.15, w: 7, h: 14 } ],
      source: "Ai-Thinker ESP-01 drawing, 2x4 header below" },
    sourcing: { mpn: "ESP-01", manufacturer: "Ai-Thinker", package: "module 24.8 x 14.3 mm, 2x4 header", generic: "ESP8266 Wi-Fi module ESP-01 (AT firmware), 3.3 V" } },
  "hc-sr04": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2.5, mounting_holes: [{ x: 1.75, y: 1.75, d: 1.8 }, { x: 43.25, y: 1.75, d: 1.8 }, { x: 1.75, y: 18.25, d: 1.8 }, { x: 43.25, y: 18.25, d: 1.8 }],
      features: [ { id: "tx", kind: "sensor-window", face: "+z", x: 10.5, y: 8.8, shape: "round", d: 16, protrude_mm: 12, description: "transmitter can" },
        { id: "rx", kind: "sensor-window", face: "+z", x: 34.5, y: 8.8, shape: "round", d: 16, protrude_mm: 12, description: "receiver can" } ],
      source: "typical HC-SR04 module (16 mm cans, 12 mm tall)" },
    sourcing: { manufacturer: "generic", package: "module 45 x 20 mm, 4-pin header", generic: "HC-SR04 ultrasonic distance sensor module, 5 V" } },
  "pir-motion": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 4, mounting_holes: [{ x: 2, y: 12, d: 2 }, { x: 30, y: 12, d: 2 }],
      features: [ { id: "dome", kind: "sensor-window", face: "+z", x: 16, y: 12, shape: "round", d: 23, protrude_mm: 12.5, description: "Fresnel dome" } ],
      source: "typical HC-SR501 (32 x 24 mm, 23 mm dome)" },
    sourcing: { manufacturer: "generic", package: "module 32 x 24 mm, 3-pin header", generic: "HC-SR501 PIR motion sensor module, 5 to 20 V in, 3.3 V out" } },
  "ir-proximity": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2, mounting_holes: [{ x: 15.5, y: 7, d: 3 }],
      features: [ { id: "emitter", kind: "sensor-window", face: "+x", x: 31, y: 4.5, z: 4, shape: "round", d: 5.2, protrude_mm: 2 },
        { id: "detector", kind: "sensor-window", face: "+x", x: 31, y: 9.5, z: 4, shape: "round", d: 5.2, protrude_mm: 2 } ],
      source: "typical FC-51 module (LEDs bent forward)" },
    sourcing: { manufacturer: "generic", package: "module 31 x 14 mm, 3-pin header", generic: "FC-51 IR obstacle avoidance sensor module, 3.3 to 5 V" } },
  "photoresistor": {
    mechanical: { keepout_bottom_mm: 3,
      features: [ { id: "window", kind: "sensor-window", face: "+z", x: 2.55, y: 2.15, shape: "round", d: 5.1, protrude_mm: 1.5 } ],
      source: "5 mm LDR (GL5528 class)" },
    sourcing: { mpn: "GL5528", package: "5 mm THT LDR", generic: "Light dependent resistor 5 mm, GL5528 class (10 to 20 kΩ at 10 lux)" } },
  "potentiometer": {
    mechanical: { keepout_bottom_mm: 3,
      features: [ { id: "shaft", kind: "knob", face: "+z", x: 4.9, y: 5.5, shape: "round", d: 6, protrude_mm: 15, description: "6 mm shaft; panel hole 7 mm" } ],
      source: "typical 9 mm rotary pot with 15 mm shaft" },
    sourcing: { manufacturer: "generic", package: "9 mm THT rotary, 3 pins 0.1 in", generic: "Potentiometer 10 kΩ linear, 9 mm, THT, 6 mm shaft" } },
  "pushbutton": {
    mechanical: { keepout_bottom_mm: 1.5,
      features: [ { id: "cap", kind: "button", face: "+z", x: 3, y: 3, shape: "round", d: 3.5, travel_mm: 0.25 } ],
      source: "6 x 6 x 5 mm tactile switch (cap 3.5 mm)" },
    sourcing: { manufacturer: "generic", package: "6 x 6 mm THT tactile, 5 mm tall", generic: "Tactile push button 6 x 6 x 5 mm, 4-pin THT" } },
  "slide-switch": {
    mechanical: { keepout_bottom_mm: 3,
      features: [ { id: "lever", kind: "switch", face: "+z", x: 4.3, y: 1.8, w: 1.5, h: 1.5, protrude_mm: 4, travel_mm: 2, description: "lever slides along x" } ],
      source: "SS12D00 class slide switch" },
    sourcing: { mpn: "SS12D00G4", package: "THT SPDT slide, 3 pins 0.1 in", generic: "Slide switch SPDT, SS12D00 type, THT" } },
  "ttp223-touch": {
    mechanical: { pcb_mm: 1.0, keepout_top_mm: 0, keepout_bottom_mm: 1.5,
      features: [ { id: "pad", kind: "button", face: "+z", x: 9.6, y: 5.7, shape: "round", d: 11, travel_mm: 0, expose: false, description: "capacitive pad; works through up to ~2 mm of plastic, so no hole is needed" } ],
      source: "typical TTP223 module" },
    sourcing: { mpn: "TTP223", manufacturer: "Tontek (IC)", package: "module 24 x 15 mm", generic: "TTP223 capacitive touch button module" } },
  "bump-switch": {
    mechanical: { keepout_bottom_mm: 3, mounting_holes: [{ x: 6.2, y: 8, d: 2.2 }, { x: 21.8, y: 8, d: 2.2 }],
      features: [ { id: "lever", kind: "button", face: "-y", x: 14, y: 0, z: 3.2, shape: "rect", w: 20, h: 4, travel_mm: 2, protrude_mm: 6, description: "hinge lever" } ],
      source: "KW12-3 micro switch with lever" },
    sourcing: { manufacturer: "generic", package: "KW12-3 micro switch 20 x 10 x 6.4 mm", generic: "Micro limit switch with hinge lever, KW12-3 type" } },
  "relay-module": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2.5, mounting_holes: [{ x: 2.5, y: 2.5, d: 3 }, { x: 47.5, y: 2.5, d: 3 }, { x: 2.5, y: 23.5, d: 3 }, { x: 47.5, y: 23.5, d: 3 }],
      features: [ { id: "terminal", kind: "connector", face: "+x", x: 50, y: 13, z: 6, w: 15, h: 10, connector: "screw-terminal-5mm", plug_clearance_mm: 1.0 },
        { id: "led", kind: "led", face: "+z", x: 37, y: 17, shape: "round", d: 3, expose: false } ],
      source: "typical 1-channel 5 V relay module" },
    sourcing: { manufacturer: "generic", package: "module 50 x 26 mm", generic: "1-channel 5 V relay module with optocoupler, 10 A contacts" } },
  "ds3231-rtc": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2.5, mounting_holes: [{ x: 2, y: 11, d: 2.5 }],
      source: "typical ZS-042 module (CR2032 holder on the back)" },
    sourcing: { mpn: "DS3231", manufacturer: "Analog Devices / Maxim (IC)", package: "module 38 x 22 mm", generic: "DS3231 RTC module ZS-042 with AT24C32 EEPROM, CR2032 holder" } },
  "bme280": {
    mechanical: { pcb_mm: 1.0, keepout_top_mm: 1.5, keepout_bottom_mm: 0.5, mounting_holes: [{ x: 10.5, y: 5.25, d: 2.5 }],
      features: [ { id: "vent", kind: "vent", face: "+z", x: 5.5, y: 5, w: 2.5, h: 2.5, expose: true, description: "needs outside air to read humidity / pressure" } ],
      source: "typical GY-BME280 module" },
    sourcing: { mpn: "BME280", manufacturer: "Bosch Sensortec (IC)", package: "module 13 x 10.5 mm", generic: "BME280 temperature / humidity / pressure module, I2C, 3.3 V" } },
  "dht22": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2.5, mounting_holes: [{ x: 3, y: 10, d: 2.5 }],
      features: [ { id: "grille", kind: "sensor-window", face: "+z", x: 23, y: 10, shape: "rect", w: 14, h: 12, description: "the sensor's own grille must see outside air" } ],
      source: "typical AM2302 on a 3-pin module" },
    sourcing: { mpn: "AM2302", manufacturer: "Aosong (sensor)", package: "module 38 x 20 mm", generic: "DHT22 / AM2302 temperature and humidity sensor module" } },
  "mpu6050": {
    mechanical: { pcb_mm: 1.6, keepout_top_mm: 1.5, keepout_bottom_mm: 0.5, mounting_holes: [{ x: 3.0, y: 13.4, d: 3 }, { x: 18.0, y: 13.4, d: 3 }],
      source: "typical GY-521 module (21.2 x 16.4 mm)" },
    sourcing: { mpn: "MPU-6050", manufacturer: "TDK InvenSense (IC)", package: "module 21 x 16 mm (GY-521)", generic: "MPU-6050 6-axis accelerometer + gyro module GY-521, I2C" } },
  "capacitive-soil-moisture": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 0, source: "typical v1.2 probe; only the electronics end goes in a case" },
    sourcing: { manufacturer: "generic", package: "probe 98 x 23 mm", generic: "Capacitive soil moisture sensor v1.2 (TLC555), analog out" } },
  "led": {
    mechanical: { outline: "round", keepout_bottom_mm: 3,
      features: [ { id: "dome", kind: "led", face: "+z", x: 2.9, y: 2.9, shape: "round", d: 5, protrude_mm: 3, description: "5 mm dome pokes through a 5.2 mm hole" } ],
      source: "5 mm THT LED" },
    sourcing: { package: "5 mm THT", generic: "LED 5 mm diffused, 20 mA" } },
  "rgb-led": {
    mechanical: { outline: "round", keepout_bottom_mm: 3,
      features: [ { id: "dome", kind: "led", face: "+z", x: 2.9, y: 2.9, shape: "round", d: 5, protrude_mm: 3 } ],
      source: "5 mm THT RGB LED" },
    sourcing: { package: "5 mm THT, 4 leads", generic: "RGB LED 5 mm common cathode, diffused" } },
  "buzzer": {
    mechanical: { outline: "round", keepout_bottom_mm: 2,
      features: [ { id: "sound", kind: "grille", face: "+z", x: 6, y: 6, shape: "round", d: 2 } ],
      source: "12 mm active buzzer (9.5 mm tall)" },
    sourcing: { package: "12 x 9.5 mm THT", generic: "Active buzzer 5 V, 12 mm, 2.4 to 2.7 kHz" } },
  "passive-buzzer": {
    mechanical: { outline: "round", keepout_bottom_mm: 2,
      features: [ { id: "sound", kind: "grille", face: "+z", x: 6, y: 6, shape: "round", d: 2 } ],
      source: "12 mm passive (magnetic) buzzer, 9.5 mm tall" },
    sourcing: { package: "12 x 9.5 mm THT", generic: "Passive magnetic buzzer 12 mm, 16 Ω class, driven by PWM" } },
  "vibration-motor": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2, source: "typical coin-motor module" },
    sourcing: { package: "module 30 x 21 mm, 10 x 2.7 mm coin motor", generic: "Vibration motor module (10 mm coin motor, driver transistor)" } },
  "ws2812-strip": {
    mechanical: { pcb_mm: 0.3, keepout_top_mm: 0.5, keepout_bottom_mm: 0.5,
      features: [ { id: "led0", kind: "led", face: "+z", x: 8.35, y: 5, w: 5, h: 5, expose: false, description: "5050 LEDs every 16.7 mm; diffuse through a thin wall or set expose true for windows" } ],
      source: "60 LED/m WS2812B strip" },
    sourcing: { mpn: "WS2812B", manufacturer: "Worldsemi (LED)", package: "5050 on 10 mm flex strip, 60/m", generic: "WS2812B addressable RGB LED strip 60 LED/m, 5 V" } },
  "lipo-battery": {
    mechanical: { soft: true, source: "503035 pouch cell (35 x 30 x 5 mm, 500 mAh); allow 10 % swell" },
    sourcing: { package: "pouch 503035 with protection PCB and JST-PH 2.0 lead", generic: "LiPo 3.7 V 1S pouch cell with protection circuit, JST-PH 2.0 lead (503035 for 500 mAh)" } },
  "tp4056-charger": {
    mechanical: { pcb_mm: 1.6, keepout_top_mm: 1.0, keepout_bottom_mm: 0.5,
      features: [ usbc("-x", 0, 8.75, 3.2, { protrude_mm: 0.8 }),
        { id: "chrg-led", kind: "led", face: "+z", x: 10.4, y: 3.3, shape: "round", d: 1.6, expose: false, description: "red CHRG LED; set expose true for a light pipe when the module sits against a wall" },
        { id: "stdby-led", kind: "led", face: "+z", x: 13.5, y: 3.3, shape: "round", d: 1.6, expose: false } ],
      source: "typical TP4056 + DW01A USB-C module (28 x 17.5 mm)" },
    sourcing: { mpn: "TP4056", manufacturer: "NanJing Top Power (IC)", package: "module 28 x 17.5 mm, USB-C", generic: "TP4056 1S LiPo charger module with DW01A protection, USB-C, 1 A (set R_PROG for small cells)" } },
  "battery-pack": {
    mechanical: { keepout_top_mm: 0, source: "4 x AA holder class; swap for the real pack" },
    sourcing: { package: "holder with 2 leads", generic: "Battery holder 4 x AA (6 V) with leads, or the pack named in the project" } },
  "l298n": {
    mechanical: { pcb_mm: 1.6, keepout_bottom_mm: 2.5, mounting_holes: [{ x: 3, y: 3, d: 3 }, { x: 40, y: 3, d: 3 }, { x: 3, y: 40, d: 3 }, { x: 40, y: 40, d: 3 }],
      features: [ { id: "heatsink", kind: "vent", face: "+z", x: 21.5, y: 21.5, w: 23, h: 16, expose: true, description: "needs airflow when driving more than ~0.5 A" } ],
      source: "typical L298N red module (43 x 43 mm)" },
    sourcing: { mpn: "L298N", manufacturer: "STMicroelectronics (IC)", package: "module 43 x 43 mm with heatsink", generic: "L298N dual H-bridge motor driver module with 5 V regulator" } },
  "servo-sg90": {
    mechanical: { keepout_bottom_mm: 0,
      features: [ { id: "horn", kind: "knob", face: "+z", x: 17.5, y: 6.1, shape: "round", d: 5, protrude_mm: 4, description: "output spline" } ],
      source: "TowerPro SG90 drawing" },
    sourcing: { mpn: "SG90", manufacturer: "TowerPro", package: "23 x 12.2 x 29 mm", generic: "SG90 micro servo 9 g, 4.8 to 6 V" } },
  "dc-motor": {
    mechanical: { source: "TT gear motor (shaft out of both sides)" },
    sourcing: { package: "70 x 22 x 18 mm", generic: "TT gear motor 3 to 6 V, 1:48, double shaft" } },
  "water-pump": {
    mechanical: { features: [ { id: "outlet", kind: "connector", face: "+x", x: 45, y: 15, z: 12, shape: "round", d: 7.5, connector: "hose-7.5mm", plug_clearance_mm: 0.5 } ], source: "typical 3 to 5 V submersible pump" },
    sourcing: { package: "45 x 30 x 24 mm", generic: "Mini submersible water pump 3 to 5 V DC, 7.5 mm outlet" } },
  "robot-chassis-2wd": {
    sourcing: { package: "kit 210 x 150 mm", generic: "2WD robot car chassis kit (acrylic plate, 2 TT motors, wheels, caster)" } },
  "resistor": {
    sourcing: { package: "THT axial 1/4 W", generic: "Resistor 1/4 W THT, 1 % metal film (value as in the BOM)" } },
};
