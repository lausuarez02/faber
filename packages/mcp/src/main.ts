import { startStdioServer } from "./server.ts";

startStdioServer().catch((err: Error) => {
  process.stderr.write(`faber MCP server failed to start: ${err.message}\n`);
  process.exit(1);
});
