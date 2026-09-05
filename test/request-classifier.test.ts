import test from "node:test";
import assert from "node:assert/strict";
import type {ClassifierTrace} from "../src/core/request-classifier.ts";
import {
  classifyRequest,
  REQUEST_CLASSIFIER_MODEL
} from "../src/core/index.js";

test("classifies a request with the pinned model and structured output", async () => {
  const translations: Array<{request: unknown; modelId: string}> = [];
  const executions: Array<{headers: HeadersInit; request: unknown; signal?: AbortSignal}> = [];
  const signal = new AbortController().signal;
  const adapter = {
    createAuthHeaders({apiKey}: {apiKey: string}) {
      return {Authorization: `Bearer ${apiKey}`};
    },
    translateRequest(args: {request: unknown; modelId: string}) {
      translations.push(args);
      return {...args.request as Record<string, unknown>, model: args.modelId, stream: false};
    },
    async createResponse(args: {headers: HeadersInit; request: unknown; signal?: AbortSignal}) {
      executions.push(args);
      return {
        output_text: JSON.stringify({
          taskCategory: "coding",
          requiredCapabilities: {
            inputModalities: ["text"],
            outputModalities: ["text"],
            toolCalls: true
          },
          confidence: 0.96,
          reason: "The request asks for a code change."
        })
      };
    }
  };

  const classification = await classifyRequest({
    adapter,
    apiKey: "test-key",
    request: {input: "Fix the parser", tools: [{type: "function"}]},
    signal
  });

  assert.equal(translations[0].modelId, REQUEST_CLASSIFIER_MODEL);
  const classifierRequest = translations[0].request as Record<string, unknown>;
  assert.match(String(classifierRequest.input), /Fix the parser/);
  const instructions = String(classifierRequest.instructions);
  assert.match(instructions, /Choose the FIRST matching category/);
  assert.match(instructions, /Code explanation is coding even if no new code is requested/);
  assert.match(instructions, /Planning ABOUT a specialized artifact is general_reasoning/);
  assert.deepEqual(
    (classifierRequest.text as {format: {type: string}}).format.type,
    "json_schema"
  );
  assert.equal((executions[0].headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.equal(executions[0].signal, signal);
  assert.deepEqual(classification, {
    taskCategory: "coding",
    requiredCapabilities: {
      inputModalities: ["text"],
      outputModalities: ["text"],
      toolCalls: true
    },
    confidence: 0.96,
    reason: "The request asks for a code change.",
    classifierModel: REQUEST_CLASSIFIER_MODEL
  });
  assert.equal(Object.isFrozen(classification), true);
  assert.equal(Object.isFrozen(classification.requiredCapabilities), true);
});

test("reads structured output from a Responses API output item", async () => {
  const adapter = createAdapter({
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          taskCategory: "data_visualization",
          requiredCapabilities: {
            inputModalities: ["text"],
            outputModalities: ["text"],
            toolCalls: false
          },
          confidence: 0.8,
          reason: "The request asks for a chart."
        })
      }]
    }]
  });

  const result = await classifyRequest({adapter, apiKey: "test-key", request: {input: "Draw a chart"}});

  assert.equal(result.taskCategory, "data_visualization");
});

test("rejects malformed or out-of-schema classifier output", async () => {
  await assert.rejects(
    classifyRequest({
      adapter: createAdapter({output_text: "not json"}),
      apiKey: "test-key",
      request: {input: "hello"}
    }),
    /invalid JSON/
  );

  await assert.rejects(
    classifyRequest({
      adapter: createAdapter({
        output_text: JSON.stringify({
          taskCategory: "unknown-category",
          requiredCapabilities: {
            inputModalities: ["text"],
            outputModalities: ["text"],
            toolCalls: false
          },
          confidence: 0.5,
          reason: "Unclear"
        })
      }),
      apiKey: "test-key",
      request: {input: "hello"}
    }),
    /task category is unsupported/
  );
});

function createAdapter(response: unknown) {
  return {
    createAuthHeaders() {
      return {};
    },
    translateRequest({request}: {request: unknown; modelId: string}) {
      return request as Record<string, unknown>;
    },
    async createResponse() {
      return response;
    }
  };
}

const traceOutput = JSON.stringify({taskCategory: "coding", requiredCapabilities: {
  inputModalities: ["text"], outputModalities: ["text"], toolCalls: false
}, confidence: 0.9, reason: "private explanation"});

test("classifier traces omit content by default and include actual usage", async () => {
  const traces: ClassifierTrace[] = [];
  await classifyRequest({adapter: createAdapter({id: "resp_1", model: "vendor/actual", output_text: traceOutput,
    usage: {input_tokens: 10, output_tokens: 20, cost: 0.001}}), apiKey: "private-key",
    request: {input: "private prompt"}, onTrace: trace => traces.push(trace)});
  assert.equal(traces.length, 1);
  assert.equal(traces[0].classification?.taskCategory, "coding");
  assert.equal(traces[0].classification?.confidence, 0.9);
  assert.equal(traces[0].actualModel, "vendor/actual");
  assert.equal(traces[0].usage.cost, 0.001);
  assert.equal(traces[0].promptVersion, "v4");
  assert.doesNotMatch(JSON.stringify(traces), /private/);
});

test("explicit diagnostic capture retains sent instructions and parsed explanation", async () => {
  const traces: ClassifierTrace[] = [];
  await classifyRequest({adapter: createAdapter({output_text: traceOutput}), apiKey: "private-key",
    request: {input: "neutral test"}, captureContent: true, onTrace: trace => traces.push(trace)});
  assert.match(JSON.stringify(traces[0].request), /Classify the supplied API request|neutral test/);
  assert.equal(traces[0].outputText, traceOutput);
  assert.equal(traces[0].classification?.reason, "private explanation");
  assert.doesNotMatch(JSON.stringify(traces), /private-key/);
});

test("invalid classifier output is traceable without downstream execution", async () => {
  const traces: ClassifierTrace[] = [];
  await assert.rejects(classifyRequest({adapter: createAdapter({output_text: "invalid json"}),
    apiKey: "test-key", request: {input: "neutral test"}, captureContent: true, onTrace: trace => traces.push(trace)}));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, "failed");
  assert.equal(traces[0].error, "invalid_classification");
  assert.equal(traces[0].outputText, "invalid json");
  assert.equal(traces[0].usage.cost, null);
});

test("captures explicit truncation and reasoning usage even when output is absent", async () => {
  let trace: ClassifierTrace | undefined;
  await assert.rejects(classifyRequest({adapter: createAdapter({status: "incomplete",
    incomplete_details: {reason: "max_output_tokens"}, output: [],
    usage: {output_tokens: 300, output_tokens_details: {reasoning_tokens: 300}}}),
    apiKey: "test-key", request: {input: "test"}, captureContent: true, onTrace: value => {trace = value;}}));
  assert.equal(trace?.upstreamStatus, "incomplete");
  assert.equal(trace?.incompleteReason, "max_output_tokens");
  assert.equal(trace?.usage.reasoningTokens, 300);
  assert.equal(trace?.outputText, null);
  assert.equal(trace?.error, "missing_output_text");
});

test("preserves partial JSON in diagnostic capture without inferring truncation", async () => {
  let trace: ClassifierTrace | undefined;
  await assert.rejects(classifyRequest({adapter: createAdapter({output_text: '{"taskCategory":',
    usage: {output_tokens: 300}}), apiKey: "test-key", request: {}, captureContent: true,
    onTrace: value => {trace = value;}}));
  assert.equal(trace?.outputText, '{"taskCategory":');
  assert.equal(trace?.incompleteReason, null);
  assert.equal(trace?.usage.reasoningTokens, null);
  assert.equal(trace?.error, "invalid_classification");
});

test("upstream exceptions have a distinct stage without retaining private error text", async () => {
  let trace: ClassifierTrace | undefined;
  const adapter = {...createAdapter({}), async createResponse() {throw new Error("private credential");}};
  await assert.rejects(classifyRequest({adapter, apiKey: "test-key", request: {},
    onTrace: value => {trace = value;}}));
  assert.equal(trace?.error, "upstream_call_failed");
  assert.equal(trace?.upstreamStatus, null);
  assert.doesNotMatch(JSON.stringify(trace), /private credential/);
});

test("unrecognized upstream status strings do not leak into default traces", async () => {
  let trace: ClassifierTrace | undefined;
  await classifyRequest({adapter: createAdapter({output_text: traceOutput, status: "private text",
    incomplete_details: {reason: "private text"}}), apiKey: "test-key", request: {},
    onTrace: value => {trace = value;}});
  assert.equal(trace?.upstreamStatus, "unknown");
  assert.equal(trace?.incompleteReason, "unknown");
  assert.doesNotMatch(JSON.stringify(trace), /private text/);
});

test("classification controls are independent from the caller's generation settings", async () => {
  let sent: Record<string, unknown> | undefined;
  const adapter = {...createAdapter({output_text: traceOutput}),
    translateRequest({request}: {request: unknown; modelId: string}) {
      sent = request as Record<string, unknown>;
      return sent;
    }};
  await classifyRequest({adapter, apiKey: "test-key", request: {
    input: "neutral task", temperature: 1, reasoning: {enabled: true},
    provider: {require_parameters: false}, max_output_tokens: 1
  }});
  assert.equal(sent?.max_output_tokens, 300);
  assert.equal(sent?.temperature, 0);
  assert.deepEqual(sent?.reasoning, {enabled: false});
  assert.deepEqual(sent?.provider, {require_parameters: true, sort: "price"});
  const format = (sent?.text as {format: {strict: boolean}}).format;
  assert.equal(format.strict, true);
  assert.match(String(sent?.instructions), /Task category and tool use are separate axes/);
});

test("classifier traces identify the selected provider without retaining endpoint details", async () => {
  let trace: ClassifierTrace | undefined;
  await classifyRequest({adapter: createAdapter({output_text: traceOutput,
    openrouter_metadata: {endpoints: {available: [
      {provider: "not selected", selected: false},
      {provider: "selected provider", selected: true, privateField: "private endpoint detail"}
    ]}}}), apiKey: "test-key", request: {}, onTrace: value => {trace = value;}});
  assert.equal(trace?.actualProvider, "selected provider");
  assert.doesNotMatch(JSON.stringify(trace), /private endpoint detail/);
});
