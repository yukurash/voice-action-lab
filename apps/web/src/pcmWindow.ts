export const WINDOW_MS = 20;
export const THRESHOLD_DBFS = -45;
export const RMS_THRESHOLD = 10 ** (THRESHOLD_DBFS / 20);
export const ACTIVE_WINDOWS = 3;
export const SILENT_WINDOWS = 6;

export type AudioDirection = "input" | "output";
export class PcmFrameDiscontinuity extends Error {
  readonly frameDelta: number;
  constructor(expected: number, actual: number) {
    super("PCM frame discontinuity.");
    this.frameDelta = actual - expected;
  }
}
export interface PcmWindowSample {
  direction: AudioDirection;
  sequence: number;
  windowStartTime: number;
  contextTime: number;
  rms: number;
  aboveThreshold: boolean;
  active: boolean;
  transition: "start" | "stop" | null;
  transitionTime: number | null;
}

export class PcmWindowMeter {
  private readonly rate: number;
  private readonly direction: AudioDirection;
  private origin = 0;
  private windowIndex = 1;
  private startFrame = 0;
  private nextFrame: number | null = null;
  private energy = 0;
  private count = 0;
  private sequence = 0;
  private above = 0;
  private below = 0;
  private candidateTime = 0;
  private active = false;

  constructor(rate: number, direction: AudioDirection) {
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error("Unsupported PCM sample rate.");
    this.rate = rate;
    this.direction = direction;
  }

  reset(): void {
    this.nextFrame = null;
    this.windowIndex = 1;
    this.energy = this.count = this.above = this.below = 0;
    this.active = false;
  }

  process(channels: readonly Float32Array[], frame: number, length: number, emit: (sample: PcmWindowSample) => void): void {
    if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isSafeInteger(length) || length < 1) {
      throw new Error("Invalid PCM frame range.");
    }
    if (this.nextFrame === null) this.origin = this.startFrame = frame;
    else if (frame !== this.nextFrame) throw new PcmFrameDiscontinuity(this.nextFrame, frame);
    for (let index = 0; index < length; ++index) {
      let power = 0;
      for (const channel of channels) {
        const value = channel[index];
        if (value === undefined || !Number.isFinite(value)) throw new Error("Invalid PCM sample.");
        power += value * value;
      }
      this.energy += power / Math.max(1, channels.length);
      ++this.count;
      const endFrame = frame + index + 1;
      if (endFrame === this.origin + Math.round(this.windowIndex * this.rate * WINDOW_MS / 1000)) {
        const rms = Math.sqrt(this.energy / this.count);
        const aboveThreshold = rms >= RMS_THRESHOLD;
        const windowStartTime = this.startFrame / this.rate;
        let transition: PcmWindowSample["transition"] = null;
        if (aboveThreshold) {
          this.above = Math.min(ACTIVE_WINDOWS, this.above + 1);
          this.below = 0;
          if (this.above === 1) this.candidateTime = windowStartTime;
          if (!this.active && this.above === ACTIVE_WINDOWS) {
            this.active = true;
            transition = "start";
          }
        } else {
          this.below = Math.min(SILENT_WINDOWS, this.below + 1);
          this.above = 0;
          if (this.below === 1) this.candidateTime = windowStartTime;
          if (this.active && this.below === SILENT_WINDOWS) {
            this.active = false;
            transition = "stop";
          }
        }
        emit({
          direction: this.direction, sequence: ++this.sequence, windowStartTime,
          contextTime: endFrame / this.rate, rms, aboveThreshold, active: this.active,
          transition, transitionTime: transition === null ? null : this.candidateTime,
        });
        this.startFrame = endFrame;
        this.energy = this.count = 0;
        ++this.windowIndex;
      }
    }
    this.nextFrame = frame + length;
  }
}
