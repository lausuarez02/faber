import { engine, useFabwright } from "../lib/app.ts";
import { onProjectSwitch } from "../lib/projectSwitch.ts";
import { useUi } from "../lib/ui.ts";
import { stopMotions } from "./imu.ts";
import { releaseAllNow } from "./press.ts";
import { useInteract } from "./store.ts";
import { stopWebcam, useCameraUi } from "./camera.ts";

/**
 * Round 6 (decision 0004, R8), canvas track: what belongs to the open project in the canvas track's
 * stores is dropped when another project opens: live values (knobs, sensors, tilt), held buttons,
 * playing motions, Arrange, the selection (and so the auto-opened inspector), and the serial
 * console's scroll position. A "reload" of the same project keeps the person's live values and
 * selection of parts that still exist. The view port is handled in shell/actions.ts.
 */
onProjectSwitch(({ reason }) => {
  const s = useFabwright.getState();
  if (reason === "open") {
    stopMotions();
    stopWebcam(); // round 13: the webcam never feeds another project's camera
    useCameraUi.setState({ shown: {}, error: undefined });
    releaseAllNow();
    useInteract.setState({ values: {}, held: {}, tilt: {}, motion: {}, arrange: false });
    s.select([], []);
    if (useUi.getState().inspectorAuto) useUi.getState().closePanel("inspector");
  } else {
    const ids = new Set(s.project.parts.map((p) => p.id));
    const wires = new Set(s.project.wires.map((w) => w.id));
    const keep = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => ids.has(k)));
    const st = useInteract.getState();
    useInteract.setState({ values: keep(st.values), tilt: keep(st.tilt) });
    s.select(
      s.selectedParts.filter((id) => ids.has(id)),
      s.selectedWires.filter((id) => wires.has(id)),
    );
  }
  engine.followSerial();
});
