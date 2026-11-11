// Pin choices of the ESP32-family peripheral fixtures, per chip (any GPIO works through the GPIO
// matrix; these avoid flash, PSRAM and USB pins). Shared by esp_io, esp_bus and esp_neopixel.
#pragma once
#if CONFIG_IDF_TARGET_ESP32
#define PIN_IRQ 4
#define PIN_LED 16
#define PIN_SERVO 17
#define PIN_TONE 25
#define PIN_ADC_A 34   // ADC1_CH6
#define PIN_ADC_B 27   // ADC2_CH7
#define PIN_SDA1 32
#define PIN_SCL1 33
#define PIN_U1_RX 26
#define PIN_U1_TX 25
#define PIN_U2_RX 13
#define PIN_U2_TX 14
#define PIN_NEO 13
#define HAS_WIRE1 1
#define HAS_SERIAL2 1
#elif CONFIG_IDF_TARGET_ESP32S3
#define PIN_IRQ 7
#define PIN_LED 4
#define PIN_SERVO 5
#define PIN_TONE 6
#define PIN_ADC_A 1    // ADC1_CH0
#define PIN_ADC_B 14   // ADC2_CH3
#define PIN_SDA1 15
#define PIN_SCL1 16
#define PIN_U1_RX 18
#define PIN_U1_TX 17
#define PIN_U2_RX 42
#define PIN_U2_TX 41
#define PIN_NEO 48
#define HAS_WIRE1 1
#define HAS_SERIAL2 1
#elif CONFIG_IDF_TARGET_ESP32C3
#define PIN_IRQ 6
#define PIN_LED 2
#define PIN_SERVO 3
#define PIN_TONE 10
#define PIN_ADC_A 0    // ADC1_CH0
#define PIN_ADC_B 1    // ADC1_CH1
#define PIN_U1_RX 18
#define PIN_U1_TX 19
#define PIN_NEO 10
#define HAS_WIRE1 0
#define HAS_SERIAL2 0
#endif
