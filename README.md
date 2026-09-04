# AutoRouter

A local request-routing gateway with inspectable model selection.

AutoRouter classifies a request, selects a model using available benchmark data, and calls that model through OpenRouter. Your client receives the response; a local trace records the decision and execution metadata.

OpenRouter is the only supported upstream for the current gateway. You need one OpenRouter key, not a separate key for each model provider. AutoRouter does not execute tools or edit files: those remain the client's responsibility.

## Install from source

Requirements: Node.js 22.18 or newer, npm, and an OpenRouter key with access and credits for the models being called. The repository is not published as an npm package.

```bash
git clone https://github.com/alanh-code/autorouter.git
cd autorouter
npm ci
```

The gateway runs TypeScript directly through Node.js. No build step is required.

## Configure the upstream key

In Bash or Zsh, run these commands. After `read`, paste your **OpenRouter key** and press Enter. Input is hidden. Do not put the key directly in a shell command or commit it.

```bash
read -r -s AUTOROUTER_UPSTREAM_API_KEY
export AUTOROUTER_UPSTREAM_API_KEY
npm run gateway -- configure-upstream openrouter
unset AUTOROUTER_UPSTREAM_API_KEY
```

Configuration validates the credential and model catalog, then saves the key in `~/.autorouter/upstream.json` with user-only permissions. This check does not prove that every model is available to your account.

You do not need to copy `.env.example`, configure individual provider keys, or edit `autorouter.config.json` for the gateway.

## Start the gateway

```bash
npm start
```

`npm run gateway` is equivalent. Keep the process running while using your client; Ctrl+C stops it. The default address is `http://127.0.0.1:8787`. To choose another port:

```bash
AUTOROUTER_PORT=8788 npm start
```

Keep the default localhost binding. The gateway has no TLS and is not intended for public network exposure.

Startup loads the model catalog. If no benchmark cache exists, it creates `~/.autorouter/benchmarks.json`; subsequent starts reuse that snapshot. There is no automatic benchmark refresh.

## Connect a client

In another terminal, display your **AutoRouter local key**:

```bash
npm run gateway -- key
```

This generates the local key if needed. The local key authenticates your client to AutoRouter. The separate OpenRouter key authenticates AutoRouter to the upstream service. Keep both out of screenshots and recordings.

Configure a client that supports a custom base URL and the Responses API:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | AutoRouter local key |
| Model | `autorouter` |
| API | Responses, not Chat Completions |

Configuration is manual. Live client compatibility has not yet been verified; automated integration tests simulate the upstream.

### Check local authentication

From the repository directory, capture the local key without printing it, then list models:

```bash
export AUTOROUTER_LOCAL_API_KEY="$(npm run --silent gateway -- key)"
node --input-type=module -e '
const response = await fetch("http://127.0.0.1:8787/v1/models", {
  headers: {Authorization: `Bearer ${process.env.AUTOROUTER_LOCAL_API_KEY}`}
});
console.log(response.status, await response.json());
'
```

Expect HTTP 200 with the virtual model `autorouter`. This does not perform model inference.

### Send a request

This calls both the classifier and selected model and can incur upstream charges:

```bash
node --input-type=module -e '
const response = await fetch("http://127.0.0.1:8787/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AUTOROUTER_LOCAL_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "autorouter",
    input: "Write a JavaScript function that adds two numbers.",
    max_output_tokens: 256,
    stream: false
  })
});
console.log(response.status, await response.json());
'
unset AUTOROUTER_LOCAL_API_KEY
```

Set `stream: true` in a streaming-capable client to receive SSE. Client disconnection cancels the upstream request; tokens already generated may still be charged.

## Routing and traces

1. A fixed classifier (`deepseek/deepseek-v4-flash-0731`) categorizes the request through OpenRouter.
2. AutoRouter filters models by published capabilities and context/output limits.
3. It ranks candidates by task-specific benchmarks where available. Estimated cost breaks score ties. If no eligible model has the relevant benchmark, it uses available pricing. Model ID breaks remaining ties.
4. The selected model ID is sent explicitly to OpenRouter, which may choose the hosting provider for that model.
5. A JSONL record is appended to `~/.autorouter/traces.jsonl` when execution ends.

Selection is deterministic for the same classification, catalog, benchmark snapshot, and token estimates. Classification itself can vary. Benchmarks are selection inputs, not proof that a model is best for a request.

Traces include a local request ID, policy version, ranked candidates, selection reason, requested model, reported actual model, upstream response ID, elapsed time, target-model usage/cost, and error state. Missing usage/cost is `null`, not zero. Cost excludes the classifier; elapsed time includes classification and execution.

Prompts, tool arguments/results, generated text, and raw error messages are not saved in traces. There is no automatic trace rotation. A storage failure prints a warning without failing the response.

## Current limits

* Request-level routing only, without task decomposition or automatic fallback.
* `GET /v1/models` and `POST /v1/responses`; no Chat Completions endpoint.
* Text input/output and function tools with text results. The client executes tools and returns `function_call_output` with complete history.
* No `previous_response_id`, multimodal input, hosted tools, or reasoning-item history support.
* A 1 MB request-body limit and a 120-second classification/execution timeout.
* Default output budget: 1,024 tokens. Use `max_output_tokens` to change it. Input budgeting uses UTF-8 byte length, not a measured tokenizer count.
* The classifier and selected model must be accessible through your account. No automatic classifier replacement is implemented.

## Key rotation and troubleshooting

```bash
npm run gateway -- rotate-key
```

Rotation prints a new local key. Restart the gateway and update the client afterward. To replace the upstream key, repeat its configuration step and restart.

* Missing `upstream.json`: configure the upstream key before starting.
* Local HTTP 401: check the local key and restart after rotation. Upstream authentication errors instead require checking the OpenRouter key.
* Unsupported request: use the Responses API, the `autorouter` model, and supported input types.
* Upstream failure: check account access, credits, and model availability. HTTP errors preserve status codes but omit raw upstream details.

## Development

```bash
npm test
npm run check
```

Tests cover routing, authentication, streaming, tool-result round trips, and trace persistence using a simulated upstream. They do not certify compatibility with a live coding client.

Legacy terminal code remains in the repository but is not part of this gateway setup.
