import { useEffect, useState } from "react";
import { useJumper } from "../lib/app.ts";
import { useLive } from "../live/liveStore.ts";
import { api, serverConnection, type ProjectsListing } from "./api.ts";
import { useProjectsUi } from "./store.ts";

/** "yes" when this page is served by jumper serve, "no" when not, undefined while asking. */
export function useServer(): "yes" | "no" | undefined {
  const [s, setS] = useState<"yes" | "no" | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void serverConnection().then((c) => alive && setS(c ? "yes" : "no"));
    return () => {
      alive = false;
    };
  }, []);
  return s;
}

/** The server's projects listing while `active`; refetched when the project changes. */
export function useProjectsListing(active: boolean): { data?: ProjectsListing; error?: string; loading: boolean } {
  const server = useServer();
  const tick = useProjectsUi((s) => s.tick);
  const [state, setState] = useState<{ data?: ProjectsListing; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!active || server !== "yes") {
      if (server === "no") setState({ loading: false });
      return;
    }
    let alive = true;
    api
      .projects()
      .then((data) => alive && setState({ data, loading: false }))
      .catch((e: Error) => alive && setState({ error: e.message, loading: false }));
    return () => {
      alive = false;
    };
  }, [active, server, tick]);
  return state;
}

/**
 * Bump the projects tick when the canvas changes (an agent step, a project switch), so the
 * history and file lists refetch. Debounced: a burst of steps is one refetch.
 */
export function useChangeTicker(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => useProjectsUi.getState().bump(), 250);
    };
    const offProject = useJumper.subscribe((s, prev) => {
      if (s.project !== prev.project) bump();
    });
    const offLive = useLive.subscribe((s, prev) => {
      if (s.ops !== prev.ops || s.dir !== prev.dir || s.steps !== prev.steps) bump();
    });
    return () => {
      clearTimeout(timer);
      offProject();
      offLive();
    };
  }, []);
}
