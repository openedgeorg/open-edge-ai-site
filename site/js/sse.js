const decoder = () => new TextDecoder("utf-8", { fatal: false });

/**
 * @param {AsyncIterable<Uint8Array|string>} chunks
 * @returns {AsyncIterable<object>}
 */
export async function* parseSse(chunks) {
  const decode = decoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decode.decode(chunk, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");
    let fence = buffer.indexOf("\n\n");
    while (fence !== -1) {
      const frame = buffer.slice(0, fence);
      buffer = buffer.slice(fence + 2);
      const event = frameToEvent(frame);
      if (event) yield event;
      fence = buffer.indexOf("\n\n");
    }
  }
  buffer += decode.decode();
}

/**
 * @param {string} frame
 * @returns {object|null}
 */
function frameToEvent(frame) {
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return JSON.parse(data.join("\n"));
}
