import type {ServerResponse} from "node:http";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

export async function writeResponseStream(
  response: ServerResponse,
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive"
  });
  response.flushHeaders();
  // Byte forwarding preserves SSE framing and lets pipeline handle backpressure.
  // A transport failure destroys the connection rather than fabricating completion.
  await pipeline(Readable.from(stream, {objectMode: false}), response, {signal});
}
