import { createInterface } from "node:readline/promises";

export async function prompt(label: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("noninteractive sign-in requires BRAIN_EMAIL, BRAIN_PASSWORD and, when needed, BRAIN_TOTP");
  if (!secret) {
    const input = createInterface({ input: process.stdin, output: process.stderr });
    try { return await input.question(`${label}: `); } finally { input.close(); }
  }
  process.stderr.write(`${label}: `);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") { finish(new Error("sign-in cancelled")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0,-1);
        else if (character >= " " && value.length < 1024) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
