const WAV_HEADER_BYTES = 44;

export class SpeechSegmenter {
  constructor({
    sampleRate = 16000,
    silenceMs = 2000,
    speechConfirmationMs = 120,
    preRollMs = 300,
    maxUtteranceMs = 120000,
    minimumSpeechRms = 500
  } = {}) {
    this.sampleRate = sampleRate;
    this.silenceMs = silenceMs;
    this.speechConfirmationMs = speechConfirmationMs;
    this.preRollMs = preRollMs;
    this.maxUtteranceMs = maxUtteranceMs;
    this.minimumSpeechRms = minimumSpeechRms;
    this.reset();
  }

  reset() {
    this.noiseFloor = 120;
    this.candidateSpeechMs = 0;
    this.silenceDurationMs = 0;
    this.utteranceDurationMs = 0;
    this.preRollDurationMs = 0;
    this.preRollFrames = [];
    this.utteranceFrames = [];
    this.speaking = false;
  }

  process(frame) {
    const samples = frame instanceof Int16Array ? frame : Int16Array.from(frame ?? []);

    if (samples.length === 0) {
      return [];
    }

    const frameMs = samples.length / this.sampleRate * 1000;
    const rms = getPcmRms(samples);
    const speechThreshold = Math.max(this.minimumSpeechRms, this.noiseFloor * 3);
    const silenceThreshold = Math.max(this.minimumSpeechRms * 0.7, this.noiseFloor * 1.8);
    const events = [];

    if (!this.speaking) {
      this.pushPreRoll(samples, frameMs);

      if (rms >= speechThreshold) {
        this.candidateSpeechMs += frameMs;
      } else {
        this.candidateSpeechMs = 0;
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      }

      if (this.candidateSpeechMs >= this.speechConfirmationMs) {
        this.speaking = true;
        this.utteranceFrames = this.preRollFrames;
        this.utteranceDurationMs = this.preRollDurationMs;
        this.preRollFrames = [];
        this.preRollDurationMs = 0;
        this.silenceDurationMs = 0;
        events.push({type: "speech-start"});
      }

      return events;
    }

    this.utteranceFrames.push(samples.slice());
    this.utteranceDurationMs += frameMs;

    if (rms <= silenceThreshold) {
      this.silenceDurationMs += frameMs;
    } else {
      this.silenceDurationMs = 0;
    }

    if (this.silenceDurationMs >= this.silenceMs || this.utteranceDurationMs >= this.maxUtteranceMs) {
      const utterance = joinPcmFrames(this.utteranceFrames);
      const reason = this.utteranceDurationMs >= this.maxUtteranceMs ? "maximum-duration" : "silence";
      this.reset();
      events.push({type: "utterance", samples: utterance, reason});
    }

    return events;
  }

  pushPreRoll(frame, frameMs) {
    this.preRollFrames.push(frame.slice());
    this.preRollDurationMs += frameMs;

    while (this.preRollDurationMs > this.preRollMs && this.preRollFrames.length > 1) {
      const removed = this.preRollFrames.shift();
      this.preRollDurationMs -= removed.length / this.sampleRate * 1000;
    }
  }
}

export function getPcmRms(samples) {
  if (!samples || samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;

  for (const sample of samples) {
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples.length);
}

export function joinPcmFrames(frames) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const joined = new Int16Array(length);
  let offset = 0;

  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }

  return joined;
}

export function encodePcmWav(samples, sampleRate = 16000) {
  const pcm = samples instanceof Int16Array ? samples : Int16Array.from(samples ?? []);
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < pcm.length; index += 1) {
    buffer.writeInt16LE(pcm[index], WAV_HEADER_BYTES + index * 2);
  }

  return buffer;
}
