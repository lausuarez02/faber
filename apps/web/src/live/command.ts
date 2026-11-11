// The followed page's channel to the `jumper serve` session (the live socket's "command" messages,
// which the server limits to WEB_OPS). LiveLayer registers the sender while the socket is open.
let sender: ((op: string, args: Record<string, unknown>) => boolean) | undefined;

export function setCommandSender(fn: typeof sender): void {
  sender = fn;
}

/** Ask the session to run `op`. False when the page is not connected to a session. */
export function sendLiveCommand(op: string, args: Record<string, unknown> = {}): boolean {
  return sender?.(op, args) ?? false;
}
