// vad_qa.ts — headless QA for the server-side VAD. No browser involved.
//
//   bun tests/vad_qa.ts <file.wav|file.webm> [--dump]
//
// Decodes the input to 16kHz mono via ffmpeg, streams it through SileroVAD one
// 512-sample frame at a time (exactly as the live WS path will), and prints the
// detected utterance segments with timestamps. With --dump, writes each segment
// to seg_N.wav so you can listen or feed them to Gemma.
import { SileroVAD, encodeWav, FRAME_SAMPLES, SAMPLE_RATE } from "../vad";

const file = process.argv[2];
const dump = process.argv.includes("--dump");
if (!file) { console.error("usage: bun vad_qa.ts <audio> [--dump]"); process.exit(1); }

// decode to raw float32le 16k mono
const ff = Bun.spawn(
  ["ffmpeg", "-loglevel", "error", "-i", file, "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "pipe:1"],
  { stdout: "pipe", stderr: "pipe" },
);
const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
if ((await ff.exited) !== 0) { console.error(await new Response(ff.stderr).text()); process.exit(1); }
const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
console.log(`decoded ${(pcm.length / SAMPLE_RATE).toFixed(2)}s  (${pcm.length} samples, ${Math.floor(pcm.length / FRAME_SAMPLES)} frames)`);

const vad = await SileroVAD.create();
const segments: { start: number; end: number; audio: Float32Array }[] = [];
let frameIdx = 0;
let startFrame = 0;

for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
  const ev = await vad.process(pcm.subarray(i, i + FRAME_SAMPLES));
  if (ev?.type === "start") startFrame = frameIdx;
  if (ev?.type === "end") {
    const start = (startFrame * FRAME_SAMPLES) / SAMPLE_RATE;
    const end = ((frameIdx + 1) * FRAME_SAMPLES) / SAMPLE_RATE;
    segments.push({ start, end, audio: ev.audio });
  }
  if (ev?.type === "misfire") console.log(`  · misfire (${ev.frames} frames) near ${(frameIdx * FRAME_SAMPLES / SAMPLE_RATE).toFixed(2)}s`);
  frameIdx++;
}
const tail = vad.flush();
if (tail?.type === "end") segments.push({ start: (startFrame * FRAME_SAMPLES) / SAMPLE_RATE, end: pcm.length / SAMPLE_RATE, audio: tail.audio });

console.log(`\n${segments.length} utterance(s):`);
for (const [i, s] of segments.entries()) {
  console.log(`  #${i + 1}  ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s   (${(s.audio.length / SAMPLE_RATE).toFixed(2)}s speech)`);
  if (dump) await Bun.write(`seg_${i + 1}.wav`, encodeWav(s.audio));
}
