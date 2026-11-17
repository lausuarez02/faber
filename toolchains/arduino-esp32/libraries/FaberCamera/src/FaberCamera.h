// Faber simulation build support for esp32-camera sketches (added by Faber's build, never by the
// person's sketch). The esp32-camera API is wrapped at link time (-Wl,--wrap) so frames come from
// Faber's camera port in the emulator; see faber_sim_camera.c. Apache-2.0.
#pragma once
#define FABER_SIM_CAMERA 1
