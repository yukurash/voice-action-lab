import { PcmFrameDiscontinuity, PcmWindowMeter } from "./pcmWindow.ts";
import type { PcmWindowSample } from "./pcmWindow.ts";

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class MeasurementProcessor extends AudioWorkletProcessor {
  private enabled = false;
  private failed = false;
  private generation = 0;
  private readonly meters = [new PcmWindowMeter(sampleRate, "input"), new PcmWindowMeter(sampleRate, "output")];

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value === null || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean"
        || !("generation" in value) || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation)) {
        throw new Error("Invalid measurement gate.");
      }
      this.enabled = value.enabled;
      this.generation = value.generation;
      this.meters.forEach((meter) => meter.reset());
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    try {
      const output = outputs[0]?.[0];
      if (!output) throw new Error("Measurement output is missing.");
      output.fill(0);
      if (this.failed) return false;
      if (!this.enabled) return true;
      const frame = currentFrame;
      const samples: PcmWindowSample[] = [];
      const collect = () => this.meters.forEach((meter, index) => {
        meter.process(inputs[index] ?? [], frame, output.length, (sample) => samples.push(sample));
      });
      try {
        collect();
      } catch (failure) {
        if (!(failure instanceof PcmFrameDiscontinuity) || failure.frameDelta <= 0) throw failure;
        // A skipped render quantum is missing evidence, never synthetic silence.
        this.meters.forEach((meter) => meter.reset());
        samples.length = 0;
        this.port.postMessage({ generation: this.generation, gapFrames: failure.frameDelta });
        collect();
      }
      if (samples.length) this.port.postMessage({ generation: this.generation, samples });
      return true;
    } catch (failure) {
      this.enabled = false;
      this.failed = true;
      this.port.postMessage({
        generation: this.generation,
        failure: failure instanceof PcmFrameDiscontinuity
          ? "frame-discontinuity" : "processor-error",
        frameDelta: failure instanceof PcmFrameDiscontinuity ? failure.frameDelta : null,
      });
      return false;
    }
  }
}

registerProcessor("voice-action-lab-pcm-measurement", MeasurementProcessor);
