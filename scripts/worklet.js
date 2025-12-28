"use strict";

const MAX_HARMONICS = 1 << 3;
const STANDARD_PITCH = 440;

const INIT_VOICES_SIZE = 1 << 2;

/** 1フレーム当たりのfade割合 */
// 1 / fadeFrames
// fadeDuration = (fadeに掛ける時間 (秒))
// fadeFrames   = (fadeに掛けるフレーム数)
//              = fadeDuration * sampleRate
const fadeRatio = 1 / (1 / 60 * sampleRate);

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
    /** Hz */
    // this.lowerLimit = STANDARD_PITCH * (2 ** (options.processorOptions.lowerLimit / 12));
    this.lowerLimit = options.processorOptions.lowerLimit;
    this.range = options.processorOptions.range;

    this.phase = new Float32Array(INIT_VOICES_SIZE * MAX_HARMONICS);
    this.freePhaseSlots = [];
    this.nextPhaseIndex = 0;
    const allocatePhaseSlot = () => {
      if (this.freePhaseSlots.length > 0) {
        return this.freePhaseSlots.pop();
      }
    
      if (this.nextPhaseIndex + MAX_HARMONICS > this.phase.length) {
        const newPhase = new Float32Array(this.phase.length * 2);
        newPhase.set(this.phase);
        this.phase = newPhase;
      }
    
      const phaseIndex = this.nextPhaseIndex;

      // phase をゼロクリア
      const phase = this.phase;
      const end = phaseIndex + MAX_HARMONICS;
      for (let i = phaseIndex; i < end; i++) {
        phase[i] = 0;
      }

      this.nextPhaseIndex += MAX_HARMONICS;
      return phaseIndex;
    }
    /**
     * @typedef {Object} Voice
     * @property {number} frequency
     * @property {number} gain
     * @property {number} targetFrequency
     * @property {number} targetGain
     * @property {number} phaseIndex 位相配列 (固定長)
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
        phaseIndex: allocatePhaseSlot(),
        stopped: false
      };
    }
    /**
     * id -> index
     */
    this.voiceMap = new Map();
    /**
     * voiceId と Voice 実体を紐付けるための参照テーブル。
     *
     * [id, Voice][] の entries 形式
     *
     * このテーブルは「参照の解決」を担当し、実体のライフサイクル管理は行わない。
     * 
     * 実体の保持・再利用は voicePool が担当する。
     * @type {{ id: number, voice: Voice }[]}
     */
    this.voices = [];
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
    this.freeVoices = (() => {
      const voices = [];
      for (let i = 0; i < INIT_VOICES_SIZE; i++) {
        voices.push(Voice());
      }
      return voices;
    })();
    /**
     * @type {number[]}
     */
    this.freeVoiceSlots = [];
    /**
     * @param {number} frequency
     * @param {number} gain
     */
    const acquireVoice = (frequency, gain) => {
      let voice = this.freeVoices.pop();
      if (voice !== undefined) {
        voice.targetFrequency = frequency;
        voice.targetGain = gain;
        voice.stopped = false;

        // phase をゼロクリア
        const base = voice.phaseIndex;
        const phase = this.phase;
        const end = base + MAX_HARMONICS;
        for (let i = base; i < end; i++) {
          phase[i] = 0;
        }
      } else {
        voice = Voice();
      }
      voice.frequency = frequency;
      voice.gain = 0;
      return voice;
    };

    // /**
    //  * @param {{
    //  *   data: {
    //  *     [id: number]: {
    //  *       type: number,
    //  *       frequency: number,
    //  *       gain: number
    //  *     }
    //  *   }
    //  * }} e
    //  */
    // this.port.onmessage = e => {
    //   for (const [id, { type, frequency, gain }] of Object.entries(e.data)) {
    //     const index = this.voiceMap.get(id);
    //     if (index !== undefined) {
    //       const entry = this.voices[index];
    //       if (entry && entry.voice.stopped) {
    //         throw new Error(
    //           "停止が命令された voice に、変更が加えられようとしています。"
    //         );
    //       }
    //     }
    //     switch (type) {
    //       case 0: { // add
    //         let index;
    //         if (this.freeVoiceSlots.length > 0) {
    //           index = this.freeVoiceSlots.pop();
    //         } else {
    //           index = this.voices.length;
    //         }
    //         this.voices[index] = { id, voice: acquireVoice(frequency, gain) };
    //         this.voiceMap.set(id, index);
    //         break;
    //       }
    //       case 1: { // update
    //         const index = this.voiceMap.get(id);
    //         if (index === undefined) break;

    //         const voice = this.voices[index].voice;
    //         voice.targetFrequency = frequency;
    //         voice.targetGain = gain;
    //         break;
    //       }
    //       case 2: { //remove
    //         const index = this.voiceMap.get(id);
    //         if (index === undefined) break;

    //         const voice = this.voices[index].voice;
    //         voice.targetGain = 0;
    //         voice.stopped = true;
    //         break;
    //       }
    //     }
    //   }
    // };
    this.port.onmessage = e => {
      const buf = e.data;
      if (!(buf instanceof Uint16Array)) throw new Error("データ型が無効です。");

      // stride = 3
      const N = buf.length;
      for (let i = 0; i < N; i += 3) {
        const w0 = buf[i];
        const w1 = buf[i + 1];
        const w2 = buf[i + 2];

        const id    = w0 >>> 6;
        const type  = (w0 >>> 4) & 0x3;
        const frequency = STANDARD_PITCH * (2 ** ((
          // semitone
          this.lowerLimit + (
            // 0-1
            (
              // ビットデータ
              ((w0 & 0xF) << 20) | (w1 << 4) | (w2 >>> 12)
            ) / 0xffffff
          ) * this.range
        ) / 12));
        const gain  = (w2 & 0xfff) / 0xfff;

        // -----------------------------
        // 5. type に応じて voice を更新
        // -----------------------------
        switch (type) {
          case 0: { // add
            let index;
            if (this.freeVoiceSlots.length > 0) {
              index = this.freeVoiceSlots.pop();
            } else {
              index = this.voices.length;
            }
            this.voices[index] = { id, voice: acquireVoice(frequency, gain) };
            this.voiceMap.set(id, index);
            break;
          }
          case 1: { // update
            const index = this.voiceMap.get(id);
            if (index === undefined) break;

            const voice = this.voices[index].voice;
            voice.targetFrequency = frequency;
            voice.targetGain = gain;
            break;
          }
          case 2: { //remove
            const index = this.voiceMap.get(id);
            if (index === undefined) break;

            const voice = this.voices[index].voice;
            voice.targetGain = 0;
            voice.stopped = true;
            break;
          }
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];

    const voiceMap = this.voiceMap;
    const voices = this.voices;
    const freeVoices = this.freeVoices;
    const freeVoiceSlots = this.freeVoiceSlots
    const phase = this.phase;
    const lower = this.lowerLimit;

    const ol = out.length;
    const vl = voices.length;
    for (let i = 0; i < ol; ++i) {
      let sample = 0;

      for (let j = 0; j < vl; ++j) {
        const entry = voices[j];
        if (entry === null) continue;
        const voice = entry.voice;      
        let f0 = voice.frequency;
        let g0 = voice.gain;

        // ---- frequency / gain の線形スムージング ----
        // target まで fade して追いつく想定（target が動いても毎サンプル再計算）
        /* frequency */ {
          const tf = voice.targetFrequency;
          const df = tf - f0;
          const step = df * fadeRatio;
          f0 = df * df <= step * step ? tf : (f0 + step);
          voice.frequency = f0;
          // if (df !== 0) {
          //   const step = df * fadeRatio;
          //   // 数値誤差で振動しないように閾値でスナップ
          //   f0 =
          //     df * df <= step * step
          //       ? tf
          //       : f0 + step
          //   ;
          //   voice.frequency = f0;
          // }
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

        const base = voice.phaseIndex;
        let maxH = (nyquist / f0) | 0;
        if (maxH > MAX_HARMONICS) maxH = MAX_HARMONICS;
        let voiceSample = 0;

        // 倍音合成
        let freqN = f0;
        let pos = base; // base + k 現在の参照位置
        for (let k = 0; k < maxH; ++k, ++pos, freqN += f0) {
          const amp = baseAmp[k] * (lower / freqN);
          let p = phase[pos];

          /*
          fastSin2pi
          高速サイン近似（7次 minimax）
          maxErr ≈ 2.3506901980496764e-10 @ t ≈ -0.044788
          */
          {
            let t = p * 4;

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
            h *= x;

            voiceSample += amp * h;
          }

          p += freqN * dt;
          if (p >= 1) p -= 1;
          phase[pos] = p;
        }

        sample += voiceSample * g0;
      }

      out[i] = sample;
    }

    for (let j = vl - 1; j >= 0; --j) {
      const entry = voices[j];
      if (entry === null) continue;
      const voice = entry.voice;
      if (voice.stopped && voice.gain === 0) {
        freeVoices.push(voice);
        voices[j] = null;
        freeVoiceSlots.push(j);
        voiceMap.delete(entry.id);
        continue;
      }
    }

    return true;
  }
}

registerProcessor("harmonic-osc", HarmonicOsc);
