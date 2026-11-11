# Plain read/write register file: reads return what was last written (0x30 reset value at offset 0 for FLASH_ACR).
if request.IsInit:
    regs = {0: 0x30}
elif request.IsWrite:
    regs[request.Offset] = request.Value
elif request.IsRead:
    request.Value = regs.get(request.Offset, 0)
