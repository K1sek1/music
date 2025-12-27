"use strict";

setTimeout(() => alert("version:\n" + "6e4e3e64-af6b-4a99-9100-e34b4c030b64"));

/** Hz */
const STANDARD_PITCH = 440;

const SEMITONE = 2 ** (1 / 12);


/** semitone 単位 */
const LOWER_LIMIT = -21;
/** semitone 単位 */
const RANGE = 36;
// const UPPER_LIMIT = LOWER_LIMIT * SEMITONE ** RANGE;



// {
//   "landscape-primary": pointers[e.pointerId].pos.y,
//   "landscape-secondary": pointers[e.pointerId].pos.y,
//   "portrait-secondary": pointers[e.pointerId].pos.x,
//   "portrait-primary": pointers[e.pointerId].pos.x
// }[screen.orientation.type] ?? console.log("このブラウザーは画面方向 API に対応していません")



// AudioContext 準備
const audioCtx = new AudioContext();
const audioWorklet = {
  /** @type {AudioWorkletNode | undefined} */
  node: undefined,
  /** 初期化 & 単一ノード生成 */
  async init() {
    if (!this.node) {
      await audioCtx.audioWorklet.addModule("scripts/worklet.js");
      this.node = new AudioWorkletNode(audioCtx, "harmonic-osc", {
        processorOptions: {
          lowerLimit: LOWER_LIMIT
        }
      });
      this.node.connect(audioCtx.destination);

      // 任意: Worklet からのログ受信用
      this.node.port.onmessage = e => {
        if (e.data?.type === "log") {
          console.log("[worklet]", e.data.msg);
        }
      };
    }
  }
  // /**
  //  * voice 追加
  //  * 
  //  * (フェードインは Worklet 側で自動)
  //  * @param {number} id
  //  * @param {{ frequency: number, gain: number }}
  //  */
  // addVoice(id, { frequency, gain }) {
  //   this.node.port.postMessage({
  //     type: "add",
  //     id,
  //     frequency,
  //     gain
  //   });
  // },
  // /**
  //  * voice 更新
  //  * 
  //  * (frequency/gain どちらか片方だけでも可)
  //  * @param {number} id
  //  * @param {{ frequency?: number, gain?: number }}
  //  */
  // updateVoice(id, { frequency, gain }) {
  //   const hasFrequency = typeof frequency === "number";
  //   const hasGain = typeof gain === "number";

  //   if (!hasFrequency && !hasGain) return;

  //   const msg = {
  //     type: "update",
  //     id
  //   };
  //   if (hasFrequency) msg.frequency = frequency;
  //   if (hasGain) msg.gain = gain;

  //   this.node.port.postMessage(msg);
  // },
  // /**
  //  * voice 削除
  //  * 
  //  * (フェードアウトは Worklet 側で自動)
  //  * @param {number} id
  //  */
  // removeVoice(id) {
  //   this.node.port.postMessage({
  //     type: "remove",
  //     id
  //   });
  // },
  // /** 一意のidを割り当て・取得 */
  // allocVoiceId: (() => {
  //   let nextVoiceId = 0;
  //   return () => nextVoiceId++;
  // })()
}



addEventListener("pointerup", () => {
  document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(() => {
    screen.orientation.lock("portrait-primary").catch(() => {});
    audioCtx.resume();
  });
}, { once: true });



/**
 * @type {{
 *   [pointerId: number]: {
 *     fixedId: number
 *     pos: [number, number],
 *     event: string | null
 *   }
 * }}
 */
const pointers = {};
audioWorklet.init().then(() => {
  const POINTER_EVENT = Object.freeze({
    none: 0,
    start: 1,
    move: 2,
    end: 3
  });
  addEventListener("pointerdown", (() => {
    const allocateFixedId = (() => {
      let nextFixedId = 0;
      return () => nextFixedId++;
    })();
    return (e => {
      if (e.button) return;
      pointers[e.pointerId] = {
        fixedId: allocateFixedId(),
        event: POINTER_EVENT.start,
        pos: pointerPos(e)
      };
    })
  })());
  addEventListener("pointermove", e => {
    const pointer = pointers[e.pointerId];
    if (!pointer) return;
    if (pointer.event === POINTER_EVENT.none) pointer.event = POINTER_EVENT.move;
    pointer.pos = pointerPos(e);
  });
  /* pointerEnd */ {
    addEventListener("pointerup", pointerEnd);
    addEventListener("pointercancel", pointerEnd);
    /** @param {PointerEvent} e */
    function pointerEnd(e) {
      const pointer = pointers[e.pointerId];
      if (!pointer) return;
      if (pointer.event === POINTER_EVENT.start) {
        delete pointers[e.pointerId];
      } else {
        pointer.event = POINTER_EVENT.end;
      }
      pointer.pos = pointerPos(e);
    }
  }
  requestAnimationFrame(function frameRequestCallback() {
    /**
     * @type {{
     *   [voiceId: number]: {
     *     type: number,
     *     frequency: number,
     *     gain: number
     *   }
     * }}
     */
    const msg = {};
    let hasMsg = false;
    for (const pointerId in pointers) {
      const pointer = pointers[pointerId];
      if (!pointer) continue;
      switch (pointer.event) {
        case POINTER_EVENT.none:
          continue;
        case POINTER_EVENT.start:
          msg[pointer.fixedId] = {
            type: 0,
            frequency: calcFrequency(pointer.pos[1]),
            gain: calcGain(pointer.pos[0])
          };
          break;
        case POINTER_EVENT.move:
          msg[pointer.fixedId] = {
            type: 1,
            frequency: calcFrequency(pointer.pos[1]),
            gain: calcGain(pointer.pos[0])
          };
          break;
        case POINTER_EVENT.end:
          msg[pointer.fixedId] = {
            type: 2,
            frequency: 0,
            gain: 0
          };
          delete pointers[pointerId];
          break;
      }
      pointer.event = POINTER_EVENT.none;
      hasMsg = true;
    }
    if (hasMsg) {
      audioWorklet.node.port.postMessage(msg);
      drawFg();
    }

    requestAnimationFrame(frameRequestCallback);
  });
  /** @param {PointerEvent} e */
  function pointerPos(e) {
    return [
      e.x / visualViewport.width,
      e.y / visualViewport.height
    ];
  }
  /**
   * @param {number} normY
   */
  function calcFrequency(normY) {
    // 0..1 -> LOWER_LIMIT..(LOWER_LIMIT+RANGE)
    return STANDARD_PITCH * SEMITONE ** (LOWER_LIMIT + RANGE * normY);
  }
  /**
   * @param {number} normX
   */
  function calcGain(normX) {
    // 元の式をそのまま使用
    // 0->0, 1->0.5, ∞->1 のスケーリングの 0.5 倍
    // y = 1 / ((2/x) - 1) * 0.5
    if (normX <= 0) return 0;
    return 1 / ((2 / normX) - 1) * 0.5;
  }
});



// #region draw
// canvas 要素を生成
const bg = document.createElement('canvas');
const fg = document.createElement('canvas');

const bgCtx = bg.getContext('2d');
const fgCtx = fg.getContext('2d');

Object.assign(bg.style, { position: "absolute" });
Object.assign(fg.style, { position: "absolute" });

const dpr = devicePixelRatio || 1;
function resizeCanvases() {
  const w = visualViewport.width;
  const h = visualViewport.height;
  [bg, fg].forEach(c => {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + "px";
    c.style.height = h + "px";
  });
  bgCtx.scale(dpr, dpr);
  fgCtx.scale(dpr, dpr);
  drawBg();
  drawFg();
}
addEventListener("resize", resizeCanvases);
resizeCanvases();

document.body.append(bg, fg);

function drawBg() {
  const w = visualViewport.width;
  const h = visualViewport.height;

  bgCtx.clearRect(0, 0, w, h);

  bgCtx.strokeStyle = "white";
  for (let i = 1; i < RANGE; ++i) {
    const data = [2, 0, 1, 0, 1, 1, 0, 1, 0, 2, 0, 1][((LOWER_LIMIT + i - 3) % 12 + 12) % 12];
    if (data) {
      bgCtx.beginPath();
      bgCtx.lineWidth = data;
      const y = (i / RANGE) * h;
      bgCtx.moveTo(0, y);
      bgCtx.lineTo(w, y);
      bgCtx.stroke();
    }
  }
}

function drawFg() {
  const w = visualViewport.width;
  const h = visualViewport.height;

  fgCtx.clearRect(0, 0, w, h);
  fgCtx.beginPath();

  fgCtx.strokeStyle = "red";
  fgCtx.lineWidth = 1;
  Object.values(pointers).forEach(pointer => {
    const y = pointer.pos[1] * h;
    fgCtx.moveTo(0, y);
    fgCtx.lineTo(w, y);
  });
  fgCtx.stroke();
}

drawBg();
// #endregion
