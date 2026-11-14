// The Raspberry Pi-style DS3231 mini module (about 14 x 14 mm, coin cell on top, no power LED and no
// charging circuit): the same DS3231 chip and register model as ds3231-rtc, with only the chip's own draw.
import { createDs3231Module } from "../ds3231-rtc/model.ts";

export const create = createDs3231Module({ chipmA: 0.11 });
