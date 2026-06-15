// ws_qa.ts — headless test of the /ws hands-free path, simulating REAL turn-taking:
// start the scene, then for each spoken command stream it, wait for the narration
// (which mirrors the browser sending "resume" after TTS), then speak the next.
//
//   bun tests/ws_qa.ts            # uses the bundled u1.wav then u2.wav
//   bun tests/ws_qa.ts a.wav b.wav c.wav
const files = process.argv.slice(2);
if (files.length === 0) files.push(`${import.meta.dir}/u1.wav`, `${import.meta.dir}/u2.wav`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function toPcm(file: string) {
  const ff = Bun.spawn(["ffmpeg", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"], { stdout: "pipe" });
  const b = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  await ff.exited;
  return b;
}

const sessionId = "qa-" + files.join("-");
// set the opening scene over HTTP (same as the Begin button)
const start = await (await fetch("http://localhost:3000/api/start", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }),
})).json();
console.log("SCENE:", start.text, "\n");

const ws = new WebSocket("ws://localhost:3000/ws");
let pending: ((text: string) => void) | null = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.type === "narration") { ws.send(JSON.stringify({ type: "resume" })); pending?.(m.text); }
  else console.log("  ◀", JSON.stringify(m));
};
await new Promise<void>((r) => { ws.onopen = () => r(); });
ws.send(JSON.stringify({ type: "hello", sessionId }));

let got = 0;
for (const f of files) {
  const pcm = await toPcm(f);
  console.log(`▶ speaking "${f}" (${(pcm.byteLength / 2 / 16000).toFixed(2)}s)`);
  const narration = new Promise<string>((res) => { pending = res; });
  for (let i = 0; i < pcm.byteLength; i += 1024) { ws.send(pcm.slice(i, i + 1024)); await sleep(10); }
  // keep the mic "open": stream room silence until the utterance closes & narration returns
  const silence = new Uint8Array(1024);
  let done = false; narration.then(() => { done = true; });
  for (let t = 0; t < 1500 && !done; t++) { ws.send(silence); await sleep(10); }
  const text = await Promise.race([narration, sleep(15000).then(() => "<<TIMEOUT>>")]);
  console.log(`  ◀ NARRATION: ${text}\n`);
  if (text !== "<<TIMEOUT>>") got++;
  await sleep(300); // brief pause between turns, mimicking the resume gap
}
console.log(`=== ${got}/${files.length} turns answered ===`);
ws.close();
