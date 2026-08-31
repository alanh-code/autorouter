import {randomUUID} from "node:crypto";

export function createModelList(models, createdAt = unixTimestamp()) {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: model.created ?? createdAt,
      owned_by: model.ownedBy ?? model.provider ?? "autorouter"
    }))
  };
}

export function createCompletedResponse({request, result, createdAt, completedAt, createId = defaultCreateId}) {
  const responseId = createId("resp");
  const messageId = createId("msg");
  const outputText = String(result.outputText ?? "");
  const output = [createMessage(messageId, outputText, "completed")];

  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    completed_at: completedAt,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: result.model ?? request.model,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: request.reasoning ?? {effort: null, summary: null},
    store: request.store ?? false,
    temperature: request.temperature ?? 1,
    text: request.text ?? {format: {type: "text"}},
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? 1,
    truncation: request.truncation ?? "disabled",
    usage: result.usage ?? null,
    metadata: request.metadata ?? {}
  };
}

export function createResponseEvents(response) {
  const completedMessage = response.output[0];
  const outputText = completedMessage.content[0].text;
  const pendingMessage = createMessage(completedMessage.id, "", "in_progress");
  const pendingResponse = {
    ...response,
    status: "in_progress",
    completed_at: null,
    output: [],
    usage: null
  };
  let sequenceNumber = 0;
  const event = (type, fields) => ({
    type,
    ...fields,
    sequence_number: sequenceNumber += 1
  });

  return [
    event("response.created", {response: pendingResponse}),
    event("response.in_progress", {response: pendingResponse}),
    event("response.output_item.added", {
      output_index: 0,
      item: pendingMessage
    }),
    event("response.content_part.added", {
      item_id: completedMessage.id,
      output_index: 0,
      content_index: 0,
      part: createOutputText("")
    }),
    ...(outputText
      ? [event("response.output_text.delta", {
          item_id: completedMessage.id,
          output_index: 0,
          content_index: 0,
          delta: outputText
        })]
      : []),
    event("response.output_text.done", {
      item_id: completedMessage.id,
      output_index: 0,
      content_index: 0,
      text: outputText
    }),
    event("response.content_part.done", {
      item_id: completedMessage.id,
      output_index: 0,
      content_index: 0,
      part: createOutputText(outputText)
    }),
    event("response.output_item.done", {
      output_index: 0,
      item: completedMessage
    }),
    event("response.completed", {response})
  ];
}

export function formatServerSentEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function createMessage(id, text, status) {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: text || status === "completed" ? [createOutputText(text)] : []
  };
}

function createOutputText(text) {
  return {
    type: "output_text",
    text,
    annotations: []
  };
}

function defaultCreateId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}
