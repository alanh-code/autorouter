import test from "node:test";
import assert from "node:assert/strict";
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
