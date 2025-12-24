"use strict";

const MAX_HARMONICS = 8;
const STANDARD_PITCH = 440;

const TABLE_SIZE = 1 << 11;         // 2048 = 2^11
const TABLE_MASK = TABLE_SIZE - 1;  // 2047

const sinTable = new Float32Array(TABLE_SIZE);
for (let i = 0; i < TABLE_SIZE; i++) {
  sinTable[i] = Math.sin((i / TABLE_SIZE) * 2 * Math.PI);
}

/** Hermite 補間（Catmull–Rom 型 4点補間） */
function hermite(table, idx) {
  const i0 = idx | 0;
  const frac = idx - i0;

  const xm1 = table[(i0 - 1) & TABLE_MASK];
  const x0  = table[i0 & TABLE_MASK];
  const x1  = table[(i0 + 1) & TABLE_MASK];
  const x2  = table[(i0 + 2) & TABLE_MASK];

  const c0 = x0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);

  return ((c3 * frac + c2) * frac + c1) * frac + c0;
}

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

        let p = this.phase[n - 1];
        sample += amp * hermite(sinTable, p * TABLE_SIZE);
        
        p += freqN * dt;
        if (p >= 1) p -= 1;
        this.phase[n - 1] = p;        
      }      

      out[i] = sample * g0;
    }

    return true;
  }
}

registerProcessor("harmonic-osc", HarmonicOsc);
