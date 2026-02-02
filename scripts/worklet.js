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
    this.baseFreq = STANDARD_PITCH * (2 ** (this.lowerLimit / 12));
    this.range = options.processorOptions.range;

    this.phase = new Float32Array(INIT_VOICES_SIZE * MAX_HARMONICS);
    const allocatePhaseSlot = (() => {
      let nextPhaseIndex = 0;
      return (() => {
        if (nextPhaseIndex + MAX_HARMONICS > this.phase.length) {
          const newPhase = new Float32Array(this.phase.length * 2);
          newPhase.set(this.phase);
          this.phase = newPhase;
        }

        const phaseIndex = nextPhaseIndex;

        // phase をゼロクリア
        const phase = this.phase;
        const end = phaseIndex + MAX_HARMONICS;
        for (let i = phaseIndex; i < end; i++) {
          phase[i] = 0;
        }

        nextPhaseIndex += MAX_HARMONICS;
        return phaseIndex;
      });
    })();
    /**
     * @typedef {Object} Voice
     * @property {number} semitone
     * @property {number} loudness
     * @property {number} targetSemitone readonly
     * @property {number} targetLoudness readonly
     * @property {number} velocitySemitone readonly
     * @property {number} velocityLoudness readonly
     * @property {number} phaseIndex 位相配列 (固定長)
     * @property {boolean} stopped
     * @property {number || undefined} freq
     * @property {number || undefined} gain
     * @property {(value: number) => void} setTargetSemitone
     * @property {(value: number) => void} setTargetLoudness
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
      let targetSemitone = 0;
      let targetLoudness = 0;
      let velocitySemitone = 0;
      let velocityLoudness = 0;
      const voice = {
        semitone: 0,
        loudness: 0,
        targetSemitone: 0,
        targetLoudness: 0,
        velocitySemitone: 0,
        velocityLoudness: 0,
        phaseIndex: allocatePhaseSlot(),
        stopped: false,
        freq: undefined,
        gain: undefined,
        setTargetSemitone(value) {
          if (
            targetSemitone !== voice.targetSemitone ||
            velocitySemitone !== voice.velocitySemitone
          ) throw new Error("値が外部から変更されています。");
          voice.targetSemitone = targetSemitone = value;
          voice.velocitySemitone = velocitySemitone = (value - voice.semitone) * fadeRatio;
        },
        setTargetLoudness(value) {
          if (
            targetLoudness !== voice.targetLoudness ||
            velocityLoudness !== voice.velocityLoudness
          ) throw new Error("値が外部から変更されています。");
          voice.targetLoudness = targetLoudness = value;
          voice.velocityLoudness = velocityLoudness = (value - voice.loudness) * fadeRatio;
        }
      };
      return voice;
    }
    /**
     * id -> index
     */
    this.voiceMap = new Map();
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
    /** @type {{ id: number, voice: Voice }[]} */
    this.activeVoices = [];
    /**
     * @param {number} semitone
     * @param {number} loudness
     */
    const acquireVoice = (semitone, loudness) => {
      let voice = this.freeVoices.pop() ?? Voice();

      voice.semitone = semitone;
      voice.loudness = 0;
      voice.setTargetSemitone(semitone);
      voice.setTargetLoudness(loudness);
      voice.stopped = false;
      voice.freq = undefined;
      voice.gain = undefined;

      /* phase をゼロクリア */ {
        const base = voice.phaseIndex;
        const phase = this.phase;
        const end = base + MAX_HARMONICS;
        for (let i = base; i < end; i++) {
          phase[i] = 0;
        }
      }

      return voice;
    };

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
        const semitone = this.lowerLimit + (
          (((w0 & 0xF) << 20) | (w1 << 4) | (w2 >>> 12)) / 0xffffff
        ) * this.range;
        const loudness = (w2 & 0xfff) / 0xfff;

        // -----------------------------
        // type に応じて voice を更新
        // -----------------------------
        switch (type) {
          case 0: { // add
            this.voiceMap.set(
              id,
              this.activeVoices.push({ id, voice: acquireVoice(semitone, loudness) }) - 1
            );
            break;
          }
          case 1: { // update
            const index = this.voiceMap.get(id);
            if (index === undefined) break;

            const voice = this.activeVoices[index].voice;
            voice.setTargetSemitone(semitone);
            voice.setTargetLoudness(loudness);
            break;
          }
          case 2: { //remove
            const index = this.voiceMap.get(id);
            if (index === undefined) break;

            const voice = this.activeVoices[index].voice;
            voice.setTargetLoudness(0);
            voice.stopped = true;
            break;
          }
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];

    const activeVoices = this.activeVoices;
    const phase = this.phase;
    const baseFreq = this.baseFreq;

    const ol = out.length;
    const vl = activeVoices.length;
    for (let i = 0; i < ol; ++i) {
      let sample = 0;

      for (let j = 0; j < vl; ++j) {
        const entry = activeVoices[j];
        const voice = entry.voice;

        // ---- freq / gain の線形スムージング ----
        // target まで fade して追いつく想定（target が動いても毎サンプル再計算）

        /* freq */ 
        let f0 = voice.freq;
        {
          let semitone = voice.semitone;
          const target = voice.targetSemitone;
          if (f0 === undefined || semitone !== target) {
            const step = voice.velocitySemitone;
            const next = semitone + step;
            voice.semitone = semitone = step > 0 && next >= target || step < 0 && next <= target ? target : next;

            f0 = voice.freq = STANDARD_PITCH * (2 ** (semitone / 12));
          }
        }

        /* gain */ 
        let gain = voice.gain;
        {
          let loudness = voice.loudness;
          const target = voice.targetLoudness;
          if (gain === undefined || loudness !== target) {
            const step = voice.velocityLoudness;
            const next = loudness + step;
            voice.loudness = loudness = step > 0 && next >= target || step < 0 && next <= target ? target : next;

            // gain = voice.gain = 1 / (2 / loudness - 1) * 0.5;

            const x2 = loudness * loudness;

            // const x3 = x2 * loudness;
            // let h = 0.0059417208181036605;        // a3
            // h = 0.049999928953109174 + x2 * h;   // a2
            // h = 0.19999977264356106 + x2 * h;    // a1
            // h = 0.7751560075753159 + x2 * h;     // a0
            // gain = voice.gain = x3 * h * 0.5;

            let h = 0.04999511718749978;
            h = 0.1999999949336052 + x2 * h;
            h = 0.7874999898567331 + x2 * h;
            h = -0.006237469904698252 + x2 * h;
            gain = voice.gain = loudness * h * 0.5;
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
          const amp = baseAmp[k] * (baseFreq / freqN);
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

        sample += voiceSample * gain;
      }

      out[i] = sample;
    }

    {
      const voiceMap = this.voiceMap;
      const freeVoices = this.freeVoices;
      for (let j = vl - 1; j >= 0; --j) {
        const entry = activeVoices[j];
        const id = entry.id;
        const voice = entry.voice;
        if (voice.stopped && voice.loudness === 0) {
          freeVoices.push(voice);
          voiceMap.delete(id);

          const lastVoice = activeVoices[activeVoices.length - 1];
          if (entry !== lastVoice) {
            activeVoices[j] = lastVoice;
            voiceMap.set(lastVoice.id, j);
          }
          activeVoices.pop();
          continue;
        }
      }
    }

    return true;
  }
}


registerProcessor("harmonic-osc", HarmonicOsc);
