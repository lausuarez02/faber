# Minimal STM32F1 RCC: every *ON bit is mirrored to its *RDY bit, SWS follows SW. Enough for HAL SystemClock_Config.
if request.IsInit:
    regs = {}
elif request.IsWrite:
    v = request.Value
    if request.Offset == 0x0:      # CR: HSION->HSIRDY, HSEON->HSERDY, PLLON->PLLRDY
        v = (v & ~((1<<1)|(1<<17)|(1<<25))) | ((v & 1) << 1) | (((v >> 16) & 1) << 17) | (((v >> 24) & 1) << 25)
    elif request.Offset == 0x4:    # CFGR: SWS[3:2] = SW[1:0]
        v = (v & ~0xC) | ((v & 0x3) << 2)
    elif request.Offset == 0x24:   # CSR: LSION->LSIRDY
        v = (v & ~2) | ((v & 1) << 1)
    elif request.Offset == 0x20:   # BDCR: LSEON->LSERDY
        v = (v & ~2) | ((v & 1) << 1)
    regs[request.Offset] = v
elif request.IsRead:
    request.Value = regs.get(request.Offset, 0x83 if request.Offset == 0 else 0)
