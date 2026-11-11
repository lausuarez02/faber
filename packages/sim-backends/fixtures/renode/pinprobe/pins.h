// Pins the probe exercises, per board: every GPIO on the board's headers except the console UART
// (TX / RX), in the order of the board part's pin list. Names are what the core accepts.
#pragma once
#if defined(ARDUINO_BLUEPILL_F103C8)
#define CONSOLE Serial
static const uint32_t PINS[] = {PB12, PB13, PB14, PB15, PA8, PA11, PA12, PA15, PB3, PB4, PB5, PB6, PB7, PB8, PB9, PB11, PB10, PB1, PB0, PA7, PA6, PA5, PA4, PA3, PA2, PA1, PA0, PC15, PC14, PC13};
static const char* NAMES[] = {"PB12", "PB13", "PB14", "PB15", "PA8", "PA11", "PA12", "PA15", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9", "PB11", "PB10", "PB1", "PB0", "PA7", "PA6", "PA5", "PA4", "PA3", "PA2", "PA1", "PA0", "PC15", "PC14", "PC13"};
#elif defined(ARDUINO_BLACKPILL_F411CE)
#define CONSOLE Serial
static const uint32_t PINS[] = {PB12, PB13, PB14, PB15, PA8, PA11, PA12, PA15, PB3, PB4, PB5, PB6, PB7, PB8, PB9, PC13, PC14, PC15, PA0, PA1, PA2, PA3, PA4, PA5, PA6, PA7, PB0, PB1, PB2, PB10};
static const char* NAMES[] = {"PB12", "PB13", "PB14", "PB15", "PA8", "PA11", "PA12", "PA15", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9", "PC13", "PC14", "PC15", "PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1", "PB2", "PB10"};
#elif defined(ARDUINO_NUCLEO_F401RE)
#define CONSOLE Serial
static const uint32_t PINS[] = {PB8, PB9, PA5, PA6, PA7, PB6, PC7, PA9, PA8, PB10, PB4, PB5, PB3, PA10, PA0, PA1, PA4, PB0, PC1, PC0, PC13};
static const char* NAMES[] = {"PB8", "PB9", "PA5", "PA6", "PA7", "PB6", "PC7", "PA9", "PA8", "PB10", "PB4", "PB5", "PB3", "PA10", "PA0", "PA1", "PA4", "PB0", "PC1", "PC0", "PC13"};
#elif defined(ARDUINO_ARDUINO_NANO33BLE)
#define CONSOLE Serial1
static const uint32_t PINS[] = {D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, A0, A1, A2, A3, A4, A5, A6, A7};
static const char* NAMES[] = {"D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7"};
#elif defined(ARDUINO_Seeed_XIAO_nRF52840)
#define CONSOLE Serial1
static const uint32_t PINS[] = {D0, D1, D2, D3, D4, D5, D8, D9, D10};
static const char* NAMES[] = {"D0", "D1", "D2", "D3", "D4", "D5", "D8", "D9", "D10"};
#else
#error "pinprobe: add this board's pins to pins.h"
#endif
static const unsigned NPINS = sizeof(PINS) / sizeof(PINS[0]);
