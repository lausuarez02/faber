// The RP2040's virtual clock. rp2040js peripherals (TIMER, PWM, ADC sample time, UART bit timing
// added by Faber) schedule alarms on an IClock; the backend advances it only from step(), by the
// time each executed instruction takes at the current clk_sys. No wall clock, no timers: the same
// firmware and inputs give the same edges on the same nanosecond on every run (decision 0003, C1).

type AlarmCallback = () => void;

export class Rp2040Alarm {
  /** Due time in ns; valid while scheduled. */
  at = 0;
  scheduled = false;
  /** Insertion order, so alarms due at the same nanosecond fire in the order they were scheduled. */
  seq = 0;

  private readonly clock: VirtualClock;
  readonly callback: AlarmCallback;

  constructor(clock: VirtualClock, callback: AlarmCallback) {
    this.clock = clock;
    this.callback = callback;
  }

  schedule(deltaNanos: number): void {
    this.clock.link(this, Math.max(0, deltaNanos));
  }

  cancel(): void {
    this.clock.unlink(this);
  }
}

/** A sorted alarm list over a float nanosecond counter (structurally rp2040js's IClock). */
export class VirtualClock {
  private now = 0;
  private alarms: Rp2040Alarm[] = [];
  private seq = 0;

  get nanos(): number {
    return this.now;
  }

  createAlarm(callback: AlarmCallback): Rp2040Alarm {
    return new Rp2040Alarm(this, callback);
  }

  link(alarm: Rp2040Alarm, delta: number): void {
    if (alarm.scheduled) this.unlink(alarm);
    alarm.at = this.now + delta;
    alarm.seq = this.seq++;
    alarm.scheduled = true;
    // Keep sorted by (at, seq); new alarms are usually the latest, so search from the end.
    let i = this.alarms.length;
    while (i > 0 && this.alarms[i - 1]!.at > alarm.at) i--;
    this.alarms.splice(i, 0, alarm);
  }

  unlink(alarm: Rp2040Alarm): void {
    if (!alarm.scheduled) return;
    alarm.scheduled = false;
    const i = this.alarms.indexOf(alarm);
    if (i >= 0) this.alarms.splice(i, 1);
  }

  /** Due time of the next alarm, or undefined. */
  get nextAlarmAt(): number | undefined {
    return this.alarms[0]?.at;
  }

  /** Advance to `target` ns, running every alarm due on the way at its own time. */
  advanceTo(target: number): void {
    for (;;) {
      const next = this.alarms[0];
      if (!next || next.at > target) break;
      this.alarms.shift();
      next.scheduled = false;
      if (next.at > this.now) this.now = next.at;
      next.callback();
    }
    if (target > this.now) this.now = target;
  }
}
