// Faber simulation build support for deep-sleep sketches (added by Faber's build, never by the
// person's sketch). The ESP-IDF sleep API is wrapped at link time (-Wl,--wrap); see
// faber_sim_sleep.c. MIT.
#pragma once
#define FABER_SIM_SLEEP 1
