import {SpeechSegmenter} from "./audio.js";

const DEFAULT_FRAME_LENGTH = 512;
const DEFAULT_NO_SPEECH_TIMEOUT_MS = 10000;

export class VoiceCapture {
  constructor({
    recorderFactory = createSystemRecorder,
    segmenterFactory = (options) => new SpeechSegmenter(options),
    silenceMs = 2000,
    noSpeechTimeoutMs = DEFAULT_NO_SPEECH_TIMEOUT_MS,
    onStatus = () => {},
    onUtterance = () => {},
    onError = () => {},
    onNoSpeech = () => {}
  } = {}) {
    this.recorderFactory = recorderFactory;
    this.segmenterFactory = segmenterFactory;
    this.silenceMs = silenceMs;
    this.noSpeechTimeoutMs = noSpeechTimeoutMs;
    this.onStatus = onStatus;
    this.onUtterance = onUtterance;
    this.onError = onError;
    this.onNoSpeech = onNoSpeech;
    this.recorder = null;
    this.running = false;
    this.starting = false;
    this.continuous = false;
    this.generation = 0;
  }

  get isRunning() {
    return this.running || this.starting;
  }

  async start({continuous = false} = {}) {
    if (this.running || this.starting) {
      return;
    }

    const generation = this.generation + 1;
    this.generation = generation;
    this.continuous = continuous;
    this.starting = true;

    try {
      const recorder = await this.recorderFactory(DEFAULT_FRAME_LENGTH);

      if (generation !== this.generation) {
        recorder.release();
        return;
      }

      this.recorder = recorder;
      this.starting = false;
      this.running = true;
      const sampleRate = recorder.sampleRate;
      const segmenter = this.segmenterFactory({sampleRate, silenceMs: this.silenceMs});
      let waitingMs = 0;
      recorder.start();
      this.onStatus("listening");

      while (this.running && generation === this.generation) {
        const frame = await recorder.read();

        if (!this.running || generation !== this.generation) {
          break;
        }

        const events = segmenter.process(frame);

        if (!segmenter.speaking) {
          waitingMs += frame.length / sampleRate * 1000;
        }

        for (const event of events) {
          if (event.type === "speech-start") {
            waitingMs = 0;
            this.onStatus("recording");
          }

          if (event.type === "utterance") {
            this.onUtterance({samples: event.samples, sampleRate, reason: event.reason});

            if (!continuous) {
              this.running = false;
              break;
            }

            waitingMs = 0;
            this.onStatus("listening");
          }
        }

        if (!continuous && !segmenter.speaking && waitingMs >= this.noSpeechTimeoutMs) {
          this.running = false;
          this.onNoSpeech();
        }
      }
    } catch (error) {
      if (generation === this.generation && this.running) {
        this.onError(error);
      } else if (generation === this.generation && !this.recorder) {
        this.onError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.starting = false;
        this.running = false;
        this.releaseRecorder();
      }
    }
  }

  stop() {
    this.generation += 1;
    this.starting = false;
    this.running = false;
    this.releaseRecorder();
  }

  releaseRecorder() {
    const recorder = this.recorder;
    this.recorder = null;

    if (!recorder) {
      return;
    }

    try {
      if (recorder.isRecording) {
        recorder.stop();
      }
    } catch {
      // The audio backend may already be stopped after a pending read is interrupted.
    }

    try {
      recorder.release();
    } catch {
      // Resource cleanup should never take down the terminal UI.
    }
  }
}

export async function createSystemRecorder(frameLength = DEFAULT_FRAME_LENGTH) {
  const module = await import("@picovoice/pvrecorder-node");
  const PvRecorder = module.PvRecorder ?? module.default?.PvRecorder;

  if (!PvRecorder) {
    throw new Error("Microphone recorder is unavailable on this platform");
  }

  return new PvRecorder(frameLength);
}
