# AutoRouter

An interactive terminal agent that routes one task across multiple models and tools.

Most CLI agents are designed around one model for the whole task. That design limits flexibility and cost control. Real tasks often split into smaller pieces: planning, current data lookup, code inspection, file edits, review, and final synthesis. Those pieces do not always need the same model.

AutoRouter lets a base model analyze your prompt, break it into execution stages, choose from your configured model inventory, ask for approval, run the stages, and return one final answer with a cost review.

## Quick Start

### Prerequisites

1. Node.js 20 or newer.
2. npm.
3. At least one model provider API key for real routing.

### Install and Run

```bash
npm install
npm start
```

Or install the local `auto` command:

```bash
npm link
auto
```

Create a default config file if needed:

```bash
node ./bin/auto init
```

## Add API Keys

Create `.env.local` from the example:

```bash
cp .env.example .env.local
```

Add only the keys you want to use:

```bash
# .env.local

# Model providers:
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
KIMI_API_KEY=

# Tool providers:
EXA_API_KEY=
```

Every key is optional, but AutoRouter only considers providers whose keys are configured. For example, if only `KIMI_API_KEY` and `EXA_API_KEY` are set, the base model picker and execution planner will only use Kimi models plus Exa web search.

`.env.local` is ignored by Git and should never be committed.

## What You Get With Keys

### With One Model Provider Key

AutoRouter can launch, choose a base model, plan stages, execute model only stages, and produce a cost review when pricing is configured.

Example:

```text
explain the difference between agent routing and model selection
```

### With Exa

AutoRouter can search current sources for questions that should not rely on model memory.

Example:

```text
summarize the latest Node.js LTS release notes
```

### With Local Workspace Access

AutoRouter can inspect the current working directory, read files, create files, and edit files inside the project.

Example:

```text
inspect package.json and explain the available scripts
```

## Core Features

### Model Picker

Use `/model` to choose the base planning model. The picker only shows models from providers that are configured and available in the current environment.

### Stage Routing

The base model decides whether to clarify, fail, or split the task into stages. Each stage can use a different configured model or tool. AutoRouter rejects invented model IDs.

### Approval Flow

Before execution, AutoRouter shows the planned route and asks for approval.

Approval options:

1. Yes.
2. Yes, and accept all execution for this session.
3. No, and tell AutoRouter what to do instead.

### Web Search

Exa is used for current information such as recent events, weather, prices, schedules, or other live data. Search results are treated as tool context and then refined by an execution model before the final answer is shown.

### Workspace Tools

Local file tools are scoped to the current working directory.

1. `local_files` reads project files.
2. `file_write` creates new local files.
3. `file_edit` edits existing local files.

### Cost Review

After execution, AutoRouter shows planning cost, stage cost, final synthesis cost, percentage share, and total cost. Provider token usage is converted into dollar estimates when pricing is configured. Exa search cost is included when available.

### Terminal Experience

1. Type `auto` to launch.
2. Type `/` to see matching slash commands.
3. Use `Shift+Enter` for multiline prompts.
4. Use arrow keys to browse prompt history.
5. Use `Ctrl+C` to clear the input when text is present.
6. Use `/exit` or `/quit` to close the app.

## How Routing Works

1. The user enters a task in the terminal.
2. The selected base model receives runtime context, workspace context, and the enabled model inventory.
3. The base model returns either a clarification question, an error, or a stage plan.
4. AutoRouter validates that every stage uses a configured model and allowed tools.
5. The user approves execution.
6. AutoRouter runs each stage, passing prior stage results forward.
7. A final synthesis model returns one user facing answer.
8. AutoRouter prints a cost review.

## Provider Model

AutoRouter is not limited to one fixed provider list. A provider needs:

1. An API key supplied by the user.
2. A provider entry in `autorouter.config.json`.
3. A runtime adapter that knows how to call that provider.

The example configuration currently includes:

1. DeepSeek.
2. OpenAI.
3. Anthropic.
4. Kimi.
5. Exa for web search.

Model and tool configuration lives in `autorouter.config.json`. The model inventory includes model IDs, labels, provider names, output caps, and pricing. The base model receives the enabled inventory and must choose exact `modelId` values from it.

Pricing is stored as dollars per 1 million tokens:

```json
{
  "inputCacheHitPerMillion": 0.19,
  "inputCacheMissPerMillion": 0.95,
  "outputPerMillion": 4
}
```

## Repository Architecture

```text
AutoRouter/
  bin/auto
    CLI entrypoint.

  src/app.js
    Ink terminal UI, input handling, slash commands, route preview, and base model prompt.

  src/config.js
    Config loading, local env loading, and default config creation.

  src/constants.js
    Shared limits and allowed tool names.

  src/costs.js
    Token and tool cost formatting.

  src/execution.js
    Stage execution, tool dispatch, final synthesis, and cost review assembly.

  src/providers/
    Chat completion adapter and enabled model inventory helpers.

  src/router/
    Base model response normalization and validation.

  src/tools/
    Exa web search plus local file read, write, and edit tools.

  src/utils/
    Runtime context and text helpers.

  test/
    Routing, execution, prompt, and normalization tests.

  autorouter.config.json
    Model provider, tool provider, model inventory, token cap, and pricing config.

  .env.example
    Local API key names. Copy this to .env.local.
```

## Try These Prompts

```text
explain the difference between agent routing and model selection
```

```text
summarize the latest Node.js LTS release notes
```

```text
inspect package.json and explain the available scripts
```

```text
create docs/setup-checklist.md with a short local setup checklist
```

```text
update README.md to mention that AutoRouter supports Exa web search
```

## Development Checks

Run syntax validation and tests:

```bash
npm run check
```

Run tests only:

```bash
npm test
```

Run the CLI:

```bash
npm start
```

## Safety Notes

1. Do not commit `.env.local`.
2. Keep real API keys out of prompts, screenshots, issues, and commits.
3. Rotate any key that was pasted into chat or exposed in logs.
4. Review `npm pack --dry-run` before publishing.
