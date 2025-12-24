"use strict";

setTimeout(() => alert("version:\n" + "3f116002-6291-465f-a565-205f86e9794b"));

/** Hz */
const STANDARD_PITCH = 440;

const SEMITONE = 2 ** (1 / 12);



const LOWER_LIMIT = -21;
const RANGE = 36;
// const UPPER_LIMIT = LOWER_LIMIT * SEMITONE ** RANGE;

const fadeDuration = 1 / 60;



// {
//   "landscape-primary": pointers[e.pointerId].pos.y,
//   "landscape-secondary": pointers[e.pointerId].pos.y,
//   "portrait-secondary": pointers[e.pointerId].pos.x,
//   "portrait-primary": pointers[e.pointerId].pos.x
// }[screen.orientation.type] ?? console.log("このブラウザーは画面方向 API に対応していません")



// AudioContext 準備
const audioCtx = new AudioContext();
const audioWorklet = {
  create() {
    return new AudioWorkletNode(audioCtx, "harmonic-osc", {
      processorOptions: {
        lowerLimit: LOWER_LIMIT
      },
      parameterData: {
        gain: 0
      }
    })
  },
  moduleURL: "scripts/worklet.js",
  /**
   * ノードを切断し、停止を命令します。
   * @param {AudioWorkletNode} node 対称のノード
   */
  stop(node) {
    node.disconnect();
    node.port.postMessage({ type: "stop" });
  }
}



addEventListener("pointerup", () => {
  document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(() => {
    screen.orientation.lock("portrait-primary").catch(() => {});
    audioCtx.resume();
  });
}, { once: true });
/** @type {{ [key: number]: { pos: [number, number], audio: AudioWorkletNode } }} */
const pointers = {};
audioCtx.audioWorklet.addModule(audioWorklet.moduleURL).then(() => {
  addEventListener("pointerdown", e => {
    if (e.button === 0) {
      pointers[e.pointerId] = {
        pos: pointerPos(e),
        audio: audioWorklet.create()
      };
      setAudio(e, true);
      pointers[e.pointerId].audio.connect(audioCtx.destination);
      drawFg();
    }
  });
  addEventListener("pointermove", e => {
    if (pointers[e.pointerId]) {
      pointers[e.pointerId].pos = pointerPos(e);
      setAudio(e);
      drawFg();
    }
  });
  addEventListener("pointerup", pointerEnd);
  addEventListener("pointercancel", pointerEnd);
  /** @param {PointerEvent} e */
  function pointerEnd(e) {
    if (e.button === 0) {
      pointers[e.pointerId].audio.parameters.get("gain")
        .cancelScheduledValues(audioCtx.currentTime)
        .setValueAtTime(pointers[e.pointerId].audio.parameters.get("gain").value, audioCtx.currentTime)
        .linearRampToValueAtTime(0, audioCtx.currentTime + fadeDuration)
      ;
      setTimeout(audio => {
        audioWorklet.stop(audio);
      }, fadeDuration * 2 * 1000, pointers[e.pointerId].audio);
      delete pointers[e.pointerId];
      drawFg();
    }
  }
  /** @param {PointerEvent} e */
  function pointerPos(e) {
    return [
      e.x / visualViewport.width,
      e.y / visualViewport.height
    ];
  }
  /** @param {PointerEvent} e */
  function setAudio(e, isInit = false) {
    const frequencyParam = pointers[e.pointerId].audio.parameters.get("frequency")
    const gainParam = pointers[e.pointerId].audio.parameters.get("gain")
    const newFrequency = STANDARD_PITCH * SEMITONE ** (LOWER_LIMIT + RANGE * pointers[e.pointerId].pos[1]);

    if (isInit) {
      frequencyParam.value = newFrequency
    } else {
      frequencyParam
        .cancelScheduledValues(audioCtx.currentTime)
        .setValueAtTime(frequencyParam.value, audioCtx.currentTime)
        .linearRampToValueAtTime(
          newFrequency,
          audioCtx.currentTime + fadeDuration
        )
      ;
    }

    gainParam
      .cancelScheduledValues(audioCtx.currentTime)
      .setValueAtTime(
        gainParam.value,
        audioCtx.currentTime
      )
      .linearRampToValueAtTime(
        /*
        0->0, 1->0.5, ∞->1
        y = x / (1 + x)
    
        0->0, 1->1, ∞->2
        y = 2x / (1 + x)
    
        y = 2x / (1 + x); x
        x = y / (2 - y)
          = 1 / ((2 / y) - 1)
        */
        1 / ((2 / pointers[e.pointerId].pos[0]) - 1) * 0.5,
        audioCtx.currentTime + fadeDuration
      )
    ;
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
