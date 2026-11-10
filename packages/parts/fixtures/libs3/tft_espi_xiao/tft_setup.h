// TFT_eSPI setup for this sketch (TFT_eSPI reads tft_setup.h instead of editing the library's
// User_Setup.h): a GC9A01 round 240x240 on a Seeed XIAO RP2040's SPI0.
#define GC9A01_DRIVER
#define TFT_WIDTH 240
#define TFT_HEIGHT 240
#define TFT_MISO -1
#define TFT_MOSI 3   // XIAO D10
#define TFT_SCLK 2   // XIAO D8
#define TFT_CS 1     // XIAO D7
#define TFT_DC 29    // XIAO D3
#define TFT_RST 28   // XIAO D2
#define LOAD_GLCD
#define SPI_FREQUENCY 20000000
