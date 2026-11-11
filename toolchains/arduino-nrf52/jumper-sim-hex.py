#!/usr/bin/env python3
"""Jumper: after a Seeeduino:nrf52 build, write <sketch>.ino.sim.hex and <sketch>.ino.uf2.

sim.hex is the whole flash the simulator boots, like a board fresh from the factory without its UF2
bootloader: Nordic's MBR + S140 SoftDevice (from the core's bootloader hex, records below the
bootloader at 0xF4000; the UICR bootloader address is left out, so the MBR starts the SoftDevice and
the SoftDevice starts the app) followed by the app. The .uf2 is the app alone, what the board's
bootloader takes over USB (family 0xADA52840).

usage: jumper-sim-hex.py <out-dir>
"""
import glob
import os
import subprocess
import sys

CORE = os.environ.get("JUMPER_NRF52_CORE") or glob.glob("/opt/arduino/data/packages/Seeeduino/hardware/nrf52/*")[0]
BOOTLOADER = glob.glob(os.path.join(CORE, "bootloader/Seeed_XIAO_nRF52840/*_s140_7.3.0.hex"))[0]
UF2CONV = os.path.join(CORE, "tools/uf2conv/uf2conv.py")
BOOTLOADER_START = 0xF4000


def records(path):
    for line in open(path):
        line = line.strip()
        if line.startswith(":"):
            yield line


def softdevice():
    base = 0
    out = []
    for r in records(BOOTLOADER):
        kind = int(r[7:9], 16)
        if kind == 4:
            base = int(r[9:13], 16) << 16
            out.append(r)
        elif kind == 2:
            base = int(r[9:13], 16) << 4
            out.append(r)
        elif kind == 0 and base + int(r[3:7], 16) < BOOTLOADER_START:
            out.append(r)
    return out


def main(out_dir):
    for app in glob.glob(os.path.join(out_dir, "*.ino.hex")):
        if app.endswith(".sim.hex"):
            continue
        stem = app[: -len(".hex")]
        app_records = [r for r in records(app) if int(r[7:9], 16) != 1]
        with open(stem + ".sim.hex", "w") as f:
            f.write("\n".join(softdevice() + [":020000040000FA"] + app_records + [":00000001FF"]) + "\n")
        subprocess.run([sys.executable, UF2CONV, "-c", "-f", "0xADA52840", "-o", stem + ".uf2", app], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main(sys.argv[1])
