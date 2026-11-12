// Jumper simulation build support for esp32-camera sketches (added by Jumper's build, never by the
// person's sketch). The esp32-camera API is wrapped at link time (-Wl,--wrap) so frames come from
// Jumper's camera port in the emulator; see jumper_sim_camera.c. Apache-2.0.
#pragma once
#define JUMPER_SIM_CAMERA 1
