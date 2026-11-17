# Bill of materials: Pocket Muse

| Qty | Part | Value / options | Ids | Buy | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Seeed XIAO RP2040 | – | xiao | [Seeed](https://www.seeedstudio.com/XIAO-RP2040-v1-0-p-5026.html), [DigiKey](https://www.digikey.com/en/products/result?keywords=XIAO%20RP2040) | – |
| 1 | Round colour display 1.28in 240x240 (GC9A01, SPI) | logic=3v3-only | eye | [AliExpress](https://www.aliexpress.com/w/wholesale-GC9A01-1.28-round-display.html), [Amazon](https://www.amazon.com/s?k=GC9A01%201.28%20inch%20round%20display) | – |
| 1 | Accelerometer + gyroscope MPU-6050 (GY-521, I2C) | – | imu | [AliExpress](https://www.aliexpress.com/w/wholesale-GY-521-MPU6050-module.html), [Amazon](https://www.amazon.com/s?k=GY-521%20MPU-6050) | – |
| 1 | Pushbutton (6 mm tactile) | – | pet | [DigiKey](https://www.digikey.com/en/products/result?keywords=6x6mm%20tactile%20switch%20THT), [AliExpress](https://www.aliexpress.com/w/wholesale-6x6x5-tactile-switch.html) | – |
| 1 | Passive buzzer (piezo, plays tones) | – | squeak | [DigiKey](https://www.digikey.com/en/products/result?keywords=piezo%20transducer%2012mm%20external%20drive), [AliExpress](https://www.aliexpress.com/w/wholesale-passive-buzzer-12mm.html) | – |
| 1 | LiPo battery 1S (3.7 V, with protection) | capacity=500 | bat | [AliExpress](https://www.aliexpress.com/w/wholesale-503035-lipo-500mah-3.7v.html), [Amazon](https://www.amazon.com/s?k=3.7V%20500mAh%20lipo%20503035%20JST) | – |
| 1 | LiPo charger module (TP4056 with protection, USB-C) | chargeCurrentmA=400 | chg | [AliExpress](https://www.aliexpress.com/w/wholesale-TP4056-type-c-protection-module.html), [Amazon](https://www.amazon.com/s?k=TP4056%20USB-C%20charger%20module%20protection) | – |
| 1 | Slide switch (SPDT) | position=0 | pwr | [DigiKey](https://www.digikey.com/en/products/result?keywords=SS12D00%20slide%20switch), [AliExpress](https://www.aliexpress.com/w/wholesale-SS12D00-slide-switch.html) | – |
| 1 | Schottky diode (1N5817, 1 A 20 V) | – | d1 | [DigiKey](https://www.digikey.com/en/products/result?keywords=1N5817), [AliExpress](https://www.aliexpress.com/w/wholesale-1N5817-schottky.html) | – |
| 1.1 m | Stranded silicone hook-up wire, 24 AWG (power and ground) | 12 pieces, see WIRE-CUTS.csv | – | [DigiKey](https://www.digikey.com/en/products/result?keywords=24%20AWG%20silicone%20wire), [Adafruit](https://www.adafruit.com/search?q=24%20AWG%20silicone%20wire) | lengths include 20 % spare |
| 1.0 m | Stranded silicone hook-up wire, 26 AWG (signals) | 10 pieces, see WIRE-CUTS.csv | – | [DigiKey](https://www.digikey.com/en/products/result?keywords=26%20AWG%20silicone%20wire), [Adafruit](https://www.adafruit.com/search?q=26%20AWG%20silicone%20wire) | lengths include 20 % spare |
| 1 | Heat-shrink tubing assortment (1.5 to 3 mm) | – | – | [DigiKey](https://www.digikey.com/en/products/result?keywords=heat%20shrink%20tubing%20assortment), [Adafruit](https://www.adafruit.com/search?q=heat%20shrink%20tubing%20assortment) | one piece over every soldered joint that could touch another |
| 1 | Rosin-core solder, 0.5 to 0.8 mm | – | – | [DigiKey](https://www.digikey.com/en/products/result?keywords=rosin%20core%20solder%200.6mm), [Adafruit](https://www.adafruit.com/search?q=rosin%20core%20solder%200.6mm) | – |

Assembly: soldered (set in faber.json ("assembly": "soldered")).

Links are generic distributor searches unless the part lists its own. Check voltage (3.3 V vs 5 V) and I2C address variants before buying.
