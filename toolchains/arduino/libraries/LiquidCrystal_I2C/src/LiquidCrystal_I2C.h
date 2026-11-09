// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Jumper Authors
//
// HD44780 character LCD on a PCF8574 I2C backpack, with the API of the widely used
// LiquidCrystal_I2C library. Written from the HD44780U and PCF8574 datasheets.
#ifndef JUMPER_LIQUIDCRYSTAL_I2C_H
#define JUMPER_LIQUIDCRYSTAL_I2C_H

#include <Arduino.h>
#include <Print.h>
#include <Wire.h>

// Instructions (HD44780U table 6)
#define LCD_CLEARDISPLAY 0x01
#define LCD_RETURNHOME 0x02
#define LCD_ENTRYMODESET 0x04
#define LCD_DISPLAYCONTROL 0x08
#define LCD_CURSORSHIFT 0x10
#define LCD_FUNCTIONSET 0x20
#define LCD_SETCGRAMADDR 0x40
#define LCD_SETDDRAMADDR 0x80
// Entry mode
#define LCD_ENTRYRIGHT 0x00
#define LCD_ENTRYLEFT 0x02
#define LCD_ENTRYSHIFTINCREMENT 0x01
#define LCD_ENTRYSHIFTDECREMENT 0x00
// Display control
#define LCD_DISPLAYON 0x04
#define LCD_DISPLAYOFF 0x00
#define LCD_CURSORON 0x02
#define LCD_CURSOROFF 0x00
#define LCD_BLINKON 0x01
#define LCD_BLINKOFF 0x00
// Cursor / display shift
#define LCD_DISPLAYMOVE 0x08
#define LCD_CURSORMOVE 0x00
#define LCD_MOVERIGHT 0x04
#define LCD_MOVELEFT 0x00
// Function set
#define LCD_8BITMODE 0x10
#define LCD_4BITMODE 0x00
#define LCD_2LINE 0x08
#define LCD_1LINE 0x00
#define LCD_5x10DOTS 0x04
#define LCD_5x8DOTS 0x00
// Backpack bits (PCF8574 P0..P3)
#define LCD_BACKLIGHT 0x08
#define LCD_NOBACKLIGHT 0x00
#define En 0x04
#define Rw 0x02
#define Rs 0x01

class LiquidCrystal_I2C : public Print {
 public:
  LiquidCrystal_I2C(uint8_t lcd_addr, uint8_t lcd_cols, uint8_t lcd_rows, uint8_t charsize = LCD_5x8DOTS);
  void begin(uint8_t cols, uint8_t rows, uint8_t charsize = LCD_5x8DOTS);
  void init();
  void clear();
  void home();
  void noDisplay();
  void display();
  void noBlink();
  void blink();
  void noCursor();
  void cursor();
  void scrollDisplayLeft();
  void scrollDisplayRight();
  void printLeft();
  void printRight();
  void leftToRight();
  void rightToLeft();
  void shiftIncrement();
  void shiftDecrement();
  void noBacklight();
  void backlight();
  bool getBacklight();
  void autoscroll();
  void noAutoscroll();
  void createChar(uint8_t location, uint8_t charmap[]);
  void createChar(uint8_t location, const char *charmap);
  void setCursor(uint8_t col, uint8_t row);
  virtual size_t write(uint8_t value);
  void command(uint8_t value);
  using Print::write;

  // LCD API 1.0 aliases
  void blink_on() { blink(); }
  void blink_off() { noBlink(); }
  void cursor_on() { cursor(); }
  void cursor_off() { noCursor(); }
  void setBacklight(uint8_t new_val) { new_val ? backlight() : noBacklight(); }
  void load_custom_character(uint8_t char_num, uint8_t *rows) { createChar(char_num, rows); }
  void printstr(const char c[]) { print(c); }

 private:
  void send(uint8_t value, uint8_t mode);
  void write4bits(uint8_t value);
  void expanderWrite(uint8_t data);
  void pulseEnable(uint8_t data);
  uint8_t _addr;
  uint8_t _displayfunction;
  uint8_t _displaycontrol;
  uint8_t _displaymode;
  uint8_t _cols;
  uint8_t _rows;
  uint8_t _charsize;
  uint8_t _backlightval;
};

#endif
