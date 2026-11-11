# nRF52 UICR as an erased flash page: reads 0xFFFFFFFF until written (the MBR and the SoftDevice
# read the bootloader address and the NFC pin config from it).
if request.IsInit:
    regs = {}
elif request.IsWrite:
    regs[request.Offset] = request.Value
elif request.IsRead:
    request.Value = regs.get(request.Offset, 0xFFFFFFFF)
