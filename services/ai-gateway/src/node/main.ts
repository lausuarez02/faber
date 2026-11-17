// fabwright-ai-gateway [--port 8787] [--host 0.0.0.0] [--provider anthropic-api|claude-cli|mock] [--ask talk]
import { chooseProvider } from "./providers.ts";
import { startGatewayServer } from "./server.ts";
import { parsePetQuery } from "../protocol.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const choice = chooseProvider(arg("provider") ? { prefer: arg("provider")! } : {});
const ask = arg("ask");
if (ask !== undefined) {
  // One question from the shell, to check the provider works: --ask "a=talk&f=40&j=70&e=80"
  const req = parsePetQuery(ask.includes("=") ? ask : `a=${ask}`);
  if (!choice.provider) {
    console.error(`no live provider: ${choice.reason}`);
    process.exit(1);
  }
  const t = Date.now();
  try {
    const r = await choice.provider.ask(req);
    console.log(`${choice.provider.label} in ${Date.now() - t} ms: ${r.mood}|${r.text}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  const { url } = await startGatewayServer({
    port: Number(arg("port") ?? 8787),
    host: arg("host") ?? "0.0.0.0",
    ...(choice.provider ? { live: choice.provider } : {}),
    log: (l) => console.log(l),
  });
  console.log(`pet AI gateway on ${url}/v1/pet: ${choice.provider ? choice.provider.label : "Mock"} (${choice.reason})`);
}
