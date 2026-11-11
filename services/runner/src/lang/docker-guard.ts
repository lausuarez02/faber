// Docker-backed tests run only when Docker answers and the image is there (10 s cap: a wedged
// Docker Desktop must not hang the suite).
import { spawnSync } from "node:child_process";

export function imagePresent(image: string): boolean {
  const r = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
  return r.status === 0;
}
