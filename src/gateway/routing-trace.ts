import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import type {RoutingDecision} from "../core/request-routing-policy.ts";

export const ROUTING_POLICY_VERSION = "benchmark-first-v1";
export const getRoutingTracePath = () => path.join(os.homedir(), ".autorouter", "traces.jsonl");

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === "string" ? value : null;

export function startRoutingTrace(filePath?: string) {
  const started = performance.now();
  const data = {
    requestId: randomUUID(), startedAt: new Date().toISOString(), policyVersion: ROUTING_POLICY_VERSION,
    decision: null as RoutingDecision | null,
    upstreamRequestId: null as string | null, actualModel: null as string | null,
    usage: null as RecordValue | null, status: "unknown", error: null as string | null,
    latencyMs: 0
  };
  let finished = false;
  function observe(value: unknown) {
    const response = record(value);
    data.upstreamRequestId = text(response.id) ?? data.upstreamRequestId;
    data.actualModel = text(response.model) ?? data.actualModel;
    if (["completed", "incomplete", "failed"].includes(String(response.status))) data.status = String(response.status);
    if (response.status === "failed" || response.error) data.error = "upstream_failure";
    if (response.usage && typeof response.usage === "object") {
      const usage = record(response.usage);
      data.usage = {inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
        totalTokens: number(usage.total_tokens), cost: number(usage.cost)};
    }
  }
  function finish(error?: string) {
    if (finished) return;
    finished = true;
    if (error) {data.status = "failed"; data.error = error;}
    data.latencyMs = Math.round(performance.now() - started);
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), {recursive: true, mode: 0o700});
      fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, {mode: 0o600});
    } catch {
      // Observability failures must not break a response that has already executed.
      console.error("Routing trace could not be saved");
    }
  }
  async function* stream(source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const decoder = new TextDecoder();
    let line = "", eventData = "", oversized = false;
    const dispatch = () => {
      if (!oversized && eventData.trim() && eventData.trim() !== "[DONE]") {
        try {
          const event = record(JSON.parse(eventData));
          if (event.response) observe(event.response);
          if (event.type === "error" || event.type === "response.failed") {
            data.status = "failed"; data.error = "upstream_failure";
          }
        } catch { /* An unrecognized event does not alter forwarded bytes. */ }
      }
      eventData = ""; oversized = false;
    };
    const consumeLine = () => {
      const current = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!current) dispatch();
      else if (current.startsWith("data:") && !oversized) {
        eventData += current.slice(5).replace(/^ /, "") + "\n";
        if (eventData.length > 1_000_000) {eventData = ""; oversized = true;}
      }
      line = "";
    };
    try {
      for await (const chunk of source) {
        // Bounded inspection only; the original bytes remain untouched.
        for (const char of decoder.decode(chunk, {stream: true})) {
          if (char === "\n") consumeLine();
          else if (line.length < 1_000_000) line += char;
          else oversized = true;
        }
        yield chunk;
      }
    } catch (error) {
      data.error = signal.aborted ? "cancelled_or_timeout" : "stream_error";
      data.status = "failed";
      throw error;
    } finally {
      if (signal.aborted) {data.error = "cancelled_or_timeout"; data.status = "failed";}
      else if (data.status === "unknown") {data.error = "stream_incomplete"; data.status = "incomplete";}
      finish();
    }
  }
  return {select(decision: RoutingDecision) {data.decision = decision;}, observe, finish, stream};
}
