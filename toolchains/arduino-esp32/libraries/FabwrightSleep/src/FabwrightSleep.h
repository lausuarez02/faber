// Fabwright simulation build support for deep-sleep sketches (added by Fabwright's build, never by the
// person's sketch). The ESP-IDF sleep API is wrapped at link time (-Wl,--wrap); see
// fabwright_sim_sleep.c. MIT.
#pragma once
#define FABWRIGHT_SIM_SLEEP 1
