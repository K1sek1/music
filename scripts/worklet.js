"use strict";
const MAX_HARMONICS = 128;
const STANDARD_PITCH = 440;

// 元の倍音構造（例：1/n ロールオフ）
const baseAmp = new Float32Array(MAX_HARMONICS);
for (let n = 1; n <= MAX_HARMONICS; ++n) {
  baseAmp[n - 1] = 1 / n;
}

class HarmonicOsc extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 440 },
      { name: "gain", defaultValue: 1 }
    ];
  }

  constructor(options) {
    super();

    this.running = true;

    /** Hz */
    this.lowerLimit = STANDARD_PITCH * (2 ** (options.processorOptions.lowerLimit / 12));

    /** 位相配列（固定長） */
    this.phase = new Float32Array(MAX_HARMONICS);

    this.port.onmessage = e => {
      switch (e.data.type) {
        case "stop":
          this.running = false
          break;
      }
    }
  }

  /**
   * 
   * @param {number} frequency Hz
   * @returns gain
   */
  getGainFromFrequency(frequency) {
    if (frequency >= sampleRate / 2) return 0;
    return this.lowerLimit  / frequency;
  }

  process(inputs, outputs, parameters) {
    if (!this.running) return false;
    const out = outputs[0][0];

    const freqParam = parameters.frequency;
    const gainParam = parameters.gain;

    const dt = 1 / sampleRate;
    const nyquist = sampleRate / 2;

    for (let i = 0; i < out.length; i++) {
      const f0 = freqParam.length > 1 ? freqParam[i] : freqParam[0];
      const g0 = gainParam.length > 1 ? gainParam[i] : gainParam[0];

      let sample = 0;

      // 固定長ループ（リアルタイム最適）
      for (let n = 1; n <= MAX_HARMONICS; n++) {
        const freqN = f0 * n;
        if (freqN > nyquist) break;

        const amp = baseAmp[n - 1] * this.getGainFromFrequency(freqN);

        sample += amp * Math.sin(this.phase[n - 1]);

        this.phase[n - 1] += freqN * dt * 2 * Math.PI;
        if (this.phase[n - 1] > Math.PI * 2) {
          this.phase[n - 1] -= Math.PI * 2;
        }
      }

      out[i] = sample * g0;
    }

    return true;
  }
}

registerProcessor("harmonic-osc", HarmonicOsc);