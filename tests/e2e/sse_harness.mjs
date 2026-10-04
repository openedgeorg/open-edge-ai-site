import { parseSse } from "../../site/js/sse.js";

const encoder = new TextEncoder();
const euro = encoder.encode("é");

async function* chunks() {
  yield encoder.encode('data: {"id":"one"}\n\ndata: {"id":"two","text":"');
  yield euro.subarray(0, 1);
  yield euro.subarray(1);
  yield encoder.encode('"}\n\n');
}

const events = [];
for await (const event of parseSse(chunks())) events.push(event);
process.stdout.write(`${JSON.stringify({ events })}\n`);
