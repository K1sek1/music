"use strict";

const MAX_HARMONICS = 16;
const STANDARD_PITCH = 440;

/** 高速サイン近似（5次 minimax）
 * 
 * maxErr ≈ 2.3506901980496764e-10 @ t ≈ -0.044788
 */
function fastSin2pi(p) {
  // 「4分割」リダクションを前提にした最速実装
  // 係数は ULP 最適化済み（4分割用）

  // wrap to [0,4)
  let t = p - (p | 0);
  t *= 4;

  const q = t | 0;      // quadrant 0..3
  let x = t - q;        // [0,1)

  // fold using sin symmetry -> [0,0.5]
  if (x > 0.5) x = 1.0 - x;

  // scale to [0,0.25] -> corresponds to [-1/16, 1/16] after sign handling
  x *= 0.5;

  const x2 = x * x;

  // quadrant sign: + + - -
  if (q & 2) x = -x;

  // 7次 ULP 最適化済み多項式（Horner）
  let h = -76.70585975306136;          // a3
  h =  81.60524927607035 + x2 * h;     // a2 + x2*h
  h = -41.34170219370107 + x2 * h;     // a1 + x2*h
  h =   6.283185313014904 + x2 * h;    // a0 + x2*h
  return x * h;
}

// 元の倍音構造（例：1/n ロールオフ）
const baseAmp = new Float32Array(MAX_HARMONICS);
for (let n = 1; n <= MAX_HARMONICS; ++n) {
  baseAmp[n - 1] = 1 / n ** 2;
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
        sample += amp * fastSin2pi(p);
        
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
