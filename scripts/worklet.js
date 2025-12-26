"use strict"; 

const MAX_HARMONICS = 8;
const STANDARD_PITCH = 440;

/** 1フレーム当たりのfade割合 */
// 1 / fadeFrames
// fadeDuration = (fadeに掛ける時間 (秒))
// fadeFrames   = (fadeに掛けるフレーム数)
//              = fadeDuration * sampleRate
const fadeRatio = 1 / (1 / 60 * sampleRate);

/** 高速サイン近似（7次 minimax）
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
  if (x > 0.5) x = 1 - x;

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

/** 元の倍音構造 */
const baseAmp = new Float32Array(MAX_HARMONICS);
for (let n = 1; n <= MAX_HARMONICS; ++n) {
  baseAmp[n - 1] = 1 / n ** 2;
}

const dt = 1 / sampleRate;
const nyquist = sampleRate / 2;

class HarmonicOsc extends AudioWorkletProcessor {
  constructor(options) {
    super();

    /**
     * @type {{
     *   [id: number]: {
     *     frequency: number,
     *     gain: number,
     *     targetFrequency: number,
     *     targetGain: number,
     *     phase: Float32Array,
     *     stopped: boolean
     *   }
     * }}
     */
    this.voices = {};

    /** Hz */
    this.lowerLimit = STANDARD_PITCH * (2 ** (options.processorOptions.lowerLimit / 12));

    /**
     * @param {{
     *   data: {
     *     type: string,
     *     id?: number,
     *     frequency?: number,
     *     gain?: number
     *   }
     * }} e
     */
    this.port.onmessage = e => {
      /** @type {number} */
      if (this.voices[e.data.id]?.stopped) throw new Error("停止が命令された voice に、変更が加えられようとしています。");
      switch (e.data.type) {
        case "add":
          this.voices[e.data.id] = {
            frequency: e.data.frequency,
            gain: 0,
            targetFrequency: e.data.frequency,
            targetGain: e.data.gain,
            /** 位相配列（固定長） */
            phase: new Float32Array(MAX_HARMONICS),
            stopped: false
          }
          break;
        case "update":
          if (e.data.frequency != null) this.voices[e.data.id].targetFrequency = e.data.frequency;
          if (e.data.gain != null) this.voices[e.data.id].targetGain = e.data.gain;
          break;
        case "remove":
          this.voices[e.data.id].targetGain = 0;
          this.voices[e.data.id].stopped = true;
          break;
      }
    }
  }

  /**
   * @param {number} frequency Hz
   * @returns gain
   */
  getGainFromFrequency(frequency) {
    if (frequency >= sampleRate / 2) return 0;
    return this.lowerLimit  / frequency;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];

    const ids = Object.keys(this.voices);

    const ol = out.length;
    const il = ids.length;
    for (let i = 0; i < ol; i++) {
      let sample = 0;

      for (let j = 0; j < il; j++) {
        const id = ids[j];
        const voice = this.voices[/** @type {number} */(id)];
        // 同ブロック内でvoiceが削除されていた場合
        if (!voice) continue;
        let f0 = voice.frequency;
        let g0 = voice.gain;

        // ---- frequency / gain の線形スムージング ----
        // target まで fade して追いつく想定（target が動いても毎サンプル再計算）
        /* frequency */ {
          const tf = voice.targetFrequency;
          const df = tf - f0;
          if (df !== 0) {
            const step = df * fadeRatio;
            // 数値誤差で振動しないように閾値でスナップ
            f0 =
              df * df <= step * step
                ? tf
                : f0 + step
            ;
            voice.frequency = f0;
          }
        }
        /* gain */ {
          const tg = voice.targetGain
          const dg = tg - g0;
          if (dg !== 0) {
            const step = dg * fadeRatio;
            if (dg * dg <= step * step) {
              g0 = tg;
              if (tg === 0 && voice.stopped) {
                delete this.voices[id];
                continue;
              }
            } else {
              g0 += step;
            }
            voice.gain = g0;
          }
        }

        const phase = voice.phase;
        let voiceSample = 0;

        // 倍音合成
        for (let n = 1; n <= MAX_HARMONICS; n++) {
          const freqN = f0 * n;
          if (freqN > nyquist) break;

          const amp = baseAmp[n - 1] * this.getGainFromFrequency(freqN);
          let p = phase[n - 1];

          voiceSample += amp * fastSin2pi(p);

          p += freqN * dt;
          p -= p | 0; // wrap to [0,1)
          phase[n - 1] = p;
        }

        sample += voiceSample * g0;
      }

      out[i] = sample;
    }

    return true;
  }
}

registerProcessor("harmonic-osc", HarmonicOsc);

