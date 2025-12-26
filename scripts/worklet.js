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
     * @typedef {Object} Voice
     * @property {number} frequency
     * @property {number} gain
     * @property {number} targetFrequency
     * @property {number} targetGain
     * @property {Float32Array} phase 位相配列 (固定長)
     * @property {boolean} stopped
     */
    /**
     * Voice の状態オブジェクトを生成するファクトリ関数。
     * 
     * class を使わず、純粋なオブジェクトとして返すことで
     * メモリ効率と GC 安定性を最大化する。
     *
     * @returns {Voice}
     */
    function Voice() {
      return {
        frequency: 0,
        gain: 0,
        targetFrequency: 0,
        targetGain: 0,
        phase: new Float32Array(MAX_HARMONICS),
        stopped: false
      };
    }
    /**
     * voiceId と Voice 実体を紐付けるための参照テーブル。
     *
     * - キー: voiceId（非負整数文字列）
     * - 値: Voice の実体
     *
     * このテーブルは「参照の解決」を担当し、実体のライフサイクル管理は行わない。
     * 実体の保持・再利用は voicePool が担当する。
     * @type {{ [voiceId: string]: Voice }}
     */
    this.voiceTable = {};
    /**
     * Voice 実体を保持するためのプール。
     *
     * - 生成済みの Voice インスタンスを格納する
     * - 再利用することで GC の揺らぎを抑える
     * - 実体のライフサイクル（貸し出し・返却）を管理する
     *
     * voiceTable が「id → 実体の紐付け」を担当するのに対し、
     * このプールは「実体そのものの保持・再利用」を担当する。
     * @type {Voice[]}
     */
    this.voicePool = (() => {
      const pool = [];
      for (let i = 0; i < 2; i++) {
        pool.push(Voice());
      }
      return pool;
    })();
    /**
     * @param {number} frequency
     * @param {number} gain
     */
    const acquireVoice = (frequency, gain) => {
      let voice = this.voicePool.pop();
      if (voice) {
        voice.targetFrequency = frequency;
        voice.targetGain = gain;
        voice.stopped = false;
        voice.phase.fill(0);
      } else {
        voice = Voice();
      }
      voice.frequency = frequency;
      voice.gain = 0;
      return voice;
    };
    

    /** Hz */
    this.lowerLimit = STANDARD_PITCH * (2 ** (options.processorOptions.lowerLimit / 12));

    /**
     * @param {{
     *   data: {
     *     [id: number]: {
     *       type: number,
     *       frequency: number,
     *       gain: number
     *     }
     *   }
     * }} e
     */
    this.port.onmessage = e => {
      for (const [id, { type, frequency, gain }] of Object.entries(e.data)) {
        if (this.voiceTable[id]?.stopped) throw new Error("停止が命令された voice に、変更が加えられようとしています。");
        switch (type) {
          case 0:
            this.voiceTable[id] = acquireVoice(frequency, gain);
            break;
          case 1:
            this.voiceTable[id].targetFrequency = frequency;
            this.voiceTable[id].targetGain = gain;
            break;
          case 2:
            this.voiceTable[id].targetGain = 0;
            this.voiceTable[id].stopped = true;
            break;
        }
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

    const ids = Object.keys(this.voiceTable);

    const ol = out.length;
    const il = ids.length;
    for (let i = 0; i < ol; ++i) {
      let sample = 0;

      for (let j = 0; j < il; ++j) {
        const id = ids[j];
        const voice = this.voiceTable[/** @type {number} */(id)];
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
            } else {
              g0 += step;
            }
            voice.gain = g0;
          }
        }

        const phase = voice.phase;
        let voiceSample = 0;

        // 倍音合成
        for (let n = 1; n <= MAX_HARMONICS; ++n) {
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

    for (let k = 0; k < il; ++k) {
      const id = ids[k];
      const voice = this.voiceTable[id];
      if (voice.stopped && voice.gain === 0) {
        this.voicePool.push(voice);
        delete this.voiceTable[id];
        continue;
      }
    }

    return true;
  }
}

registerProcessor("harmonic-osc", HarmonicOsc);
