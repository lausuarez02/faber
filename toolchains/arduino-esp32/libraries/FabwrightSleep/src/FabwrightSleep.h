// Jumper simulation build support for deep-sleep sketches (added by Jumper's build, never by the
// person's sketch). The ESP-IDF sleep API is wrapped at link time (-Wl,--wrap); see
// jumper_sim_sleep.c. MIT.
#pragma once
#define JUMPER_SIM_SLEEP 1
