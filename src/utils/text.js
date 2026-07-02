export function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function limitInputText(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[truncated for test cost control]`;
}

export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, (match) => match.replaceAll("```", ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function wrapPlainText(line, width) {
  if (line === "") {
    return [""];
  }

  if (line.length <= width) {
    return [line];
  }

  const normalized = line.replace(/\s+/g, " ").trim();

  if (normalized.length <= width) {
    return [normalized];
  }

  const words = normalized.split(" ");
  const wrapped = [];
  let current = "";

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        wrapped.push(current);
        current = "";
      }

      for (let index = 0; index < word.length; index += width) {
        wrapped.push(word.slice(index, index + width));
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;

    if (next.length > width) {
      wrapped.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped;
}

export function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

export function normalizeInsertedText(text) {
  return text.replace(/\r/g, "\n").replace(/\\\n/g, "\n");
}

export function truncateText(text, width) {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width <= 3) {
    return text.slice(0, width);
  }

  return `${text.slice(0, width - 3)}...`;
}
