import { DEFAULT_PORT, RUNNER_IMAGE } from "./config.ts";
import { startRunnerServer } from "./server.ts";

const i = process.argv.indexOf("--port");
const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.FABER_RUNNER_PORT ?? DEFAULT_PORT);
startRunnerServer(port)
  .then(() => console.error(`faber runner listening on http://127.0.0.1:${port} (image ${RUNNER_IMAGE})`))
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
