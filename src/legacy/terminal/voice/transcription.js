import {encodePcmWav} from "./audio.js";

export const DEFAULT_VOICE_CONFIG = {
  provider: "groq",
  apiKeyEnv: "GROQ_API_KEY",
  apiBaseUrl: "https://api.groq.com/openai/v1",
  model: "whisper-large-v3-turbo"
};
export const DEFAULT_TRANSCRIPTION_MODEL = DEFAULT_VOICE_CONFIG.model;
const TRANSCRIPTION_PROMPT = "The speaker is dictating a prompt for Autorouter, a terminal AI agent. Preserve technical terms, filenames, CLI commands, and model names accurately.";

export function getVoiceAvailabilityError(config) {
  const voice = getVoiceConfig(config);

  if (!voice.apiKeyEnv || !process.env[voice.apiKeyEnv]) {
    return `Voice input requires ${voice.apiKeyEnv || DEFAULT_VOICE_CONFIG.apiKeyEnv}.`;
  }

  return null;
}

export async function transcribePcm({samples, sampleRate, config, signal, fetchImpl = fetch}) {
  const voice = getVoiceConfig(config);
  const availabilityError = getVoiceAvailabilityError(config);

  if (availabilityError) {
    throw new Error(availabilityError);
  }

  const apiKey = process.env[voice.apiKeyEnv];
  const wav = encodePcmWav(samples, sampleRate);
  const form = new FormData();
  form.append("file", new Blob([wav], {type: "audio/wav"}), "dictation.wav");
  form.append("model", voice.model);
  form.append("response_format", "json");
  form.append("prompt", TRANSCRIPTION_PROMPT);

  const baseUrl = String(voice.apiBaseUrl).replace(/\/$/, "");
  const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {Authorization: `Bearer ${apiKey}`},
    body: form,
    signal
  });

  if (!response.ok) {
    throw new Error(`${formatProviderName(voice.provider)} transcription API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = typeof data?.text === "string" ? data.text.trim() : "";

  if (!text) {
    throw new Error(`${formatProviderName(voice.provider)} transcription API returned empty text`);
  }

  return {text, usage: data.usage ?? null};
}

export function getVoiceConfig(config) {
  return {...DEFAULT_VOICE_CONFIG, ...(config?.voice ?? {})};
}

function formatProviderName(provider) {
  const name = String(provider ?? DEFAULT_VOICE_CONFIG.provider);
  return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
}
