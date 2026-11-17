import { CORE_HEADERS, libraryForHeader } from "./config.ts";

/** One compiler message mapped back to the project's own files. */
export interface CompileDiagnostic {
  severity: "error" | "warning" | "note";
  /** Path relative to the project, e.g. "firmware/pet/pet.ino"; undefined for linker / tool errors. */
  file?: string;
  line?: number;
  column?: number;
  message: string;
  /** What to do about it, in one sentence. */
  hint?: string;
}

const HINTS: { re: RegExp; hint: (m: RegExpMatchArray) => string }[] = [
  {
    re: /fatal error: ([^:]+): No such file or directory/,
    hint: (m) => {
      const header = m[1]!.trim();
      const lib = libraryForHeader(header);
      if (lib) return `'${header}' comes from the "${lib}" library: add "${lib}" to firmware.libraries (MCP: set_libraries, or fabwright.json firmware.libraries) and build again.`;
      if (CORE_HEADERS.includes(header)) return `'${header}' is part of the Arduino core; check the spelling and case of the #include.`;
      return `No library provides '${header}' yet: check the #include spelling, or add the Arduino library that ships it to firmware.libraries ("Library Name" or "Library Name@1.2.3", as in the Arduino Library Manager).`;
    },
  },
  { re: /'([^']+)' was not declared in this scope/, hint: (m) => `'${m[1]}' is used before it is declared: check spelling and case, declare it above this line, or #include the header that defines it (Arduino names: HIGH, LOW, INPUT_PULLUP, LED_BUILTIN, A0..A5).` },
  { re: /expected '[;,)]' before/, hint: () => "A ';' or ')' is missing at the end of the previous statement (often the line above the one reported)." },
  { re: /expected '}' at end of input/, hint: () => "A '{' is never closed: count the braces of the function this line belongs to." },
  { re: /'([^']+)' does not name a type/, hint: (m) => `'${m[1]}' is not a known type: #include its library header (and add the library to firmware.libraries), or fix the spelling.` },
  { re: /no matching function for call to '([^']+)'/, hint: (m) => `No overload of '${m[1]}' takes these arguments: check the number and types of the arguments against the library's API.` },
  { re: /redefinition of '([^']+)'/, hint: (m) => `'${m[1]}' is defined twice. Arduino merges every .ino file in the sketch folder into one, so keep each function in only one file.` },
  { re: /undefined reference to `([^']+)'/, hint: (m) => (m[1] === "setup" || m[1] === "loop" ? `The sketch has no ${m[1]}() function; every Arduino sketch needs both void setup() and void loop().` : `'${m[1]}' is declared but never defined: write its body, or add the library that implements it to firmware.libraries.`) },
  { re: /Sketch too big|text section exceeds available space/, hint: () => "The program is larger than the 32 KB flash of the ATmega328P: remove unused libraries/fonts, or store fewer bitmaps." },
  { re: /data section exceeds available space|Not enough memory/, hint: () => "Global variables use more than the 2 KB of RAM: wrap constant strings in F(\"...\"), make tables PROGMEM, shrink buffers (an SSD1306 128x64 buffer alone takes 1 KB)." },
  { re: /Low memory available/, hint: () => "Less than ~25% RAM is left for the stack and heap; the SSD1306 library allocates 1 KB at runtime, so begin() may fail. Use F(\"...\") for strings and smaller buffers." },
  { re: /invalid conversion from '([^']+)' to '([^']+)'/, hint: (m) => `Types do not match (${m[1]} → ${m[2]}): cast explicitly or change the variable's type.` },
  { re: /lvalue required|assignment of read-only/, hint: () => "You are assigning to something that cannot change (a constant or an expression); assign to a variable instead." },
];

export function hintFor(message: string): string | undefined {
  for (const h of HINTS) {
    const m = message.match(h.re);
    if (m) return h.hint(m);
  }
  return undefined;
}

/**
 * Parse gcc/arduino-cli output. `pathMap` turns container paths ("/work/sketch/x.ino") into project paths
 * ("firmware/x.ino"). Lines that are not diagnostics are ignored; tool-level errors become file-less entries.
 */
export function parseCompilerOutput(output: string, pathMap: (containerPath: string) => string | undefined): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    let m = line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/);
    if (m) {
      const file = pathMap(m[1]!);
      if (!file) continue; // inside a library or the core: the user's own line is reported separately
      const severity = m[4] === "warning" ? "warning" : m[4] === "note" ? "note" : "error";
      const message = m[4] === "fatal error" ? `fatal error: ${m[5]}` : m[5]!;
      const d: CompileDiagnostic = { severity, file, line: Number(m[2]), message };
      if (m[3]) d.column = Number(m[3]);
      const hint = hintFor(message);
      if (hint) d.hint = hint;
      push(d);
      continue;
    }
    m = line.match(/undefined reference to `[^']+'/);
    if (m) {
      push({ severity: "error", message: m[0], hint: hintFor(m[0]) ?? "" });
      continue;
    }
    if (/Sketch too big|text section exceeds|data section exceeds|Not enough memory/.test(line)) {
      push({ severity: "error", message: line.trim(), hint: hintFor(line) ?? "" });
      continue;
    }
    if (/Low memory available/.test(line)) {
      push({ severity: "warning", message: line.trim(), hint: hintFor(line) ?? "" });
      continue;
    }
    m = line.match(/^Error during build: (.*)$/) ?? line.match(/^Error: (.*)$/);
    if (m && !/exit status 1/.test(m[1]!)) {
      push({ severity: "error", message: m[1]!.trim(), hint: hintFor(m[1]!) ?? "" });
    }
  }
  return out.map((d) => (d.hint === "" ? (({ hint: _h, ...rest }) => rest)(d) : d));

  function push(d: CompileDiagnostic) {
    const key = `${d.file}:${d.line}:${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  }
}
