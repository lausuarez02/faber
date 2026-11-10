import { useEffect, useState } from "react";
import { initialExample, useJumper } from "../lib/app.ts";
import { exampleSources } from "../lib/examples.ts";
import { api } from "./api.ts";
import { useServer } from "./data.ts";
import { useProjectsUi } from "./store.ts";

/**
 * The project's firmware source files for the Firmware panel: from the local server, else the
 * bundled example's sources when the canvas shows that example. Paths start with "firmware/".
 */
export function useFirmwareFiles(): string[] {
  const server = useServer();
  const tick = useProjectsUi((s) => s.tick);
  const sketch = useJumper((s) => s.project.firmware?.sketch);
  const name = useJumper((s) => s.project.name);
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      let list: string[] = [];
      if (server === "yes") {
        list = await api
          .files()
          .then((r) => r.files.map((f) => f.path).filter((p) => !/\.(hex|bin|elf|eep)$/.test(p)))
          .catch(() => []);
      } else if (server === "no" && initialExample.source === "file" && name === initialExample.project.name) {
        list = Object.keys(await exampleSources(initialExample.example)).sort();
      }
      if (alive) setFiles(list);
    })();
    return () => {
      alive = false;
    };
  }, [server, tick, sketch, name]);
  return files;
}
