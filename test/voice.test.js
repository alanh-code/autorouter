import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseVoiceModeByInput,
  formatInputLine,
  getSafeInputWidth,
  getVoiceActivityLabel,
  insertDictationText
} from "../src/app.js";
import {encodePcmWav, getPcmRms, SpeechSegmenter} from "../src/voice/audio.js";
import {VoiceCapture} from "../src/voice/recorder.js";
import {OrderedAsyncQueue} from "../src/voice/queue.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  getVoiceAvailabilityError,
  transcribePcm
} from "../src/voice/transcription.js";

test("encodes mono 16-bit PCM as a valid WAV buffer", () => {
  const wav = encodePcmWav(new Int16Array([0, 32767, -32768]), 16000);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(46), 32767);
  assert.equal(wav.length, 50);
  assert.equal(getPcmRms(new Int16Array([1000, -1000])), 1000);
});

test("speech segmenter confirms speech and ends after configured silence", () => {
  const segmenter = new SpeechSegmenter({
    sampleRate: 1000,
    silenceMs: 200,
    speechConfirmationMs: 200,
    preRollMs: 100,
    minimumSpeechRms: 500
  });
  const speech = new Int16Array(100).fill(2000);
  const silence = new Int16Array(100);

  assert.deepEqual(segmenter.process(speech), []);
  assert.equal(segmenter.process(speech)[0]?.type, "speech-start");
  assert.deepEqual(segmenter.process(silence), []);
  const events = segmenter.process(silence);

  assert.equal(events[0]?.type, "utterance");
  assert.equal(events[0]?.reason, "silence");
  assert.ok(events[0]?.samples.length >= 300);
  assert.equal(segmenter.speaking, false);
});

test("voice capture stops one-shot recording after an utterance and releases resources", async () => {
  const calls = [];
  const frames = [new Int16Array([1]), new Int16Array([2])];
  const recorder = {
    sampleRate: 1000,
    isRecording: false,
    start() {
      this.isRecording = true;
      calls.push("start");
    },
    async read() {
      return frames.shift();
    },
    stop() {
      this.isRecording = false;
      calls.push("stop");
    },
    release() {
      calls.push("release");
    }
  };
  const segmenter = {
    speaking: false,
    process(frame) {
      if (frame[0] === 1) {
        this.speaking = true;
        return [{type: "speech-start"}];
      }

      this.speaking = false;
      return [{type: "utterance", samples: new Int16Array([7, 8]), reason: "silence"}];
    }
  };
  let utterance = null;
  const capture = new VoiceCapture({
    recorderFactory: async () => recorder,
    segmenterFactory: () => segmenter,
    onUtterance: (value) => {
      utterance = value;
    }
  });

  await capture.start({continuous: false});

  assert.deepEqual([...utterance.samples], [7, 8]);
  assert.equal(utterance.sampleRate, 1000);
  assert.deepEqual(calls, ["start", "stop", "release"]);
  assert.equal(capture.isRunning, false);
});

test("voice capture reports no speech and cleans up", async () => {
  const calls = [];
  const recorder = {
    sampleRate: 1000,
    isRecording: false,
    start() {
      this.isRecording = true;
    },
    async read() {
      return new Int16Array(100);
    },
    stop() {
      this.isRecording = false;
      calls.push("stop");
    },
    release() {
      calls.push("release");
    }
  };
  let timedOut = false;
  const capture = new VoiceCapture({
    recorderFactory: async () => recorder,
    segmenterFactory: () => ({speaking: false, process: () => []}),
    noSpeechTimeoutMs: 200,
    onNoSpeech: () => {
      timedOut = true;
    }
  });

  await capture.start();

  assert.equal(timedOut, true);
  assert.deepEqual(calls, ["stop", "release"]);
});

test("ordered queue delivers concurrent transcription results in recording order", async () => {
  const queue = new OrderedAsyncQueue();
  const delivered = [];
  let resolveFirst;
  let resolveSecond;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });

  const firstDone = queue.enqueue(first, {onSuccess: (value) => delivered.push(value)});
  const secondDone = queue.enqueue(second, {onSuccess: (value) => delivered.push(value)});
  resolveSecond("second");
  await Promise.resolve();
  assert.deepEqual(delivered, []);
  resolveFirst("first");
  await Promise.all([firstDone, secondDone]);

  assert.deepEqual(delivered, ["first", "second"]);
});

test("transcription uses the configured Groq key and multipart request", async () => {
  const originalKey = process.env.AUTOROUTER_VOICE_TEST_KEY;
  process.env.AUTOROUTER_VOICE_TEST_KEY = "voice-test-key";
  let request = null;
  const config = {
    voice: {
      provider: "groq",
      apiKeyEnv: "AUTOROUTER_VOICE_TEST_KEY",
      apiBaseUrl: "https://voice.example/openai/v1/",
      model: "whisper-large-v3-turbo"
    }
  };

  try {
    const result = await transcribePcm({
      samples: new Int16Array([1, 2]),
      sampleRate: 16000,
      config,
      fetchImpl: async (url, options) => {
        request = {url, options};
        return {
          ok: true,
          async json() {
            return {text: "  dictated prompt  ", usage: {total_tokens: 4}};
          }
        };
      }
    });

    assert.equal(result.text, "dictated prompt");
    assert.equal(request.url, "https://voice.example/openai/v1/audio/transcriptions");
    assert.equal(request.options.headers.Authorization, "Bearer voice-test-key");
    assert.equal(request.options.body.get("model"), DEFAULT_TRANSCRIPTION_MODEL);
    assert.equal(request.options.body.get("response_format"), "json");
    assert.equal(request.options.body.get("file").type, "audio/wav");
  } finally {
    if (originalKey === undefined) {
      delete process.env.AUTOROUTER_VOICE_TEST_KEY;
    } else {
      process.env.AUTOROUTER_VOICE_TEST_KEY = originalKey;
    }
  }
});

test("voice helpers select modes, report availability, and insert editable text", () => {
  assert.equal(chooseVoiceModeByInput("1"), "off");
  assert.equal(chooseVoiceModeByInput("tab"), "key");
  assert.equal(chooseVoiceModeByInput("free"), "free");
  assert.equal(chooseVoiceModeByInput("unknown"), null);

  assert.deepEqual(insertDictationText("hello world", 5, "new idea"), {
    value: "hello new idea world",
    cursorOffset: 14
  });
  assert.deepEqual(insertDictationText("", 0, "start here"), {
    value: "start here",
    cursorOffset: 10
  });
  assert.deepEqual(insertDictationText("", 0, "  hello\n\tworld  "), {
    value: "hello world",
    cursorOffset: 11
  });

  assert.equal(getVoiceActivityLabel("off", "off"), "off");
  assert.equal(getVoiceActivityLabel("key", "ready"), "Tab to talk");
  assert.equal(getVoiceActivityLabel("free", "listening", 1), "listening · transcribing");
  const originalGroqKey = process.env.GROQ_API_KEY;

  try {
    delete process.env.GROQ_API_KEY;
    assert.match(getVoiceAvailabilityError({}), /GROQ_API_KEY/);
  } finally {
    if (originalGroqKey !== undefined) {
      process.env.GROQ_API_KEY = originalGroqKey;
    }
  }
});

test("input line stays compact while the cursor moves", () => {
  const atEnd = formatInputLine("hello", 12, true, 5);
  const inMiddle = formatInputLine("hello", 12, true, 2);
  const truncated = formatInputLine("hello world", 8, true, null);

  assert.equal(atEnd, "> hello▌");
  assert.equal(inMiddle, "> he▌lo");
  assert.equal(truncated, "> hello ");
  assert.equal(atEnd.length, 8);
  assert.equal(inMiddle.length, 7);
  assert.equal(truncated.length, 8);
});

test("input panel reserves the terminal auto-wrap column", () => {
  assert.equal(getSafeInputWidth(180, 2), 177);
  assert.equal(getSafeInputWidth(80), 79);
  assert.equal(getSafeInputWidth(1), 1);
});
