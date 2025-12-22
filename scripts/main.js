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

const audioCtx = new AudioContext();



// PeriodicWaveを生成
const wave = (() => {
  const harmonics = 512; // 倍音数
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);

  // real[0] = 0, imag[0] = 0;

  // 1/fスペクトルを近似
  for (let i = 1; i < harmonics; i++) {
    // i & 1 ? 1 / i ** 2 : 0
    // (i ** -(i & 1 ? 1 : 2)) * Math.abs((i - 16) / 15) / i
    // (i & 1 ? i ** -1 : i ** -2) * Math.abs((i - 16) / 15) / i
    // ((k, p) => 1 / (1 + ((i - 1) / k) ** p))(...i & 1 ? [4, 4] : [0.5, 8])
    // i === 1 ? 0 : ((k, p) => 1 / (1 + (((i-1) - 1) / k) ** p))(...[[8, 4], [0.5, 8], [1, 8], [0.5, 8]][i - 2 & 3])
    imag[i] = ((C, k, p) => C / (1 + ((i - 1) / k) ** p))(i & 1 ? 1 : 0.625, 2.75, 3.375); // 振幅
    real[i] = 0; // 位相
  }

  console.log(imag);
  return audioCtx.createPeriodicWave(real, imag, { disableNormalization: true });
})();



addEventListener("pointerup", () => {
  document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(() => {
    /*if (document.fullscreenElement) */screen.orientation.lock("portrait-primary").catch(() => {});
  });
}, { once: true });
/** @type {{ [key: number]: { pos: { x: number, y: number }, audio: { osc: OscillatorNode, gain: GainNode } } }} */
const pointers = {}; {
  addEventListener("pointerdown", e => {
    if (e.button === 0) {
      pointers[e.pointerId] = {
        pos: pointerPos(e),
        audio: {
          osc: audioCtx.createOscillator(),
          gain: audioCtx.createGain()
        }
      };
      pointers[e.pointerId].audio.osc.setPeriodicWave(wave);
      // pointers[e.pointerId].audio.osc.type = "square";
      pointers[e.pointerId].audio.gain.gain.value = 0;
      setAudio(e, true);
      pointers[e.pointerId].audio.osc
        .connect(pointers[e.pointerId].audio.gain)
        .connect(audioCtx.destination)
      ;
      pointers[e.pointerId].audio.osc.start();
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
      pointers[e.pointerId].audio.gain.gain
        .cancelScheduledValues(audioCtx.currentTime)
        .setValueAtTime(pointers[e.pointerId].audio.gain.gain.value, audioCtx.currentTime)
        .linearRampToValueAtTime(0, audioCtx.currentTime + fadeDuration)
      ;
      pointers[e.pointerId].audio.osc.stop(audioCtx.currentTime + fadeDuration * 2);
      delete pointers[e.pointerId];
      drawFg();
    }
  }
  /** @param {PointerEvent} e */
  function pointerPos(e) {
    return {
      x: e.pageX / document.documentElement.scrollWidth,
      y: e.pageY / document.documentElement.scrollHeight
    };
  }
  /** @param {PointerEvent} e */
  function setAudio(e, isInit = false) {
    pointers[e.pointerId].audio.osc.frequency
      .cancelScheduledValues(audioCtx.currentTime)
      .setValueAtTime(pointers[e.pointerId].audio.osc.frequency.value, audioCtx.currentTime)
      .linearRampToValueAtTime(
        STANDARD_PITCH * SEMITONE ** (LOWER_LIMIT + RANGE * pointers[e.pointerId].pos.y),
        audioCtx.currentTime + (isInit ? 0 : fadeDuration)
      )
    ;

    /*
    0->0, 1->0.5, ∞->1
    y = x / (1 + x)

    0->0, 1->1, ∞->2
    y = 2x / (1 + x)

    y = 2x / (1 + x); x
    x = y / (2 - y)
      = 1 / ((2 / y) - 1)
    */
    pointers[e.pointerId].audio.gain.gain
      .cancelScheduledValues(audioCtx.currentTime)
      .setValueAtTime(pointers[e.pointerId].audio.gain.gain.value, audioCtx.currentTime)
      .linearRampToValueAtTime(
        pointers[e.pointerId].pos.x / (2 - pointers[e.pointerId].pos.x) * 0.5,
        audioCtx.currentTime + fadeDuration
      )
    ;
  }
}



// canvas 要素を生成
const bg = document.createElement('canvas');
const fg = document.createElement('canvas');

const bgCtx = bg.getContext('2d');
const fgCtx = fg.getContext('2d');

const w = document.body.scrollWidth;
const h = document.body.scrollHeight;

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
    const y = pointer.pos.y * h;
    fgCtx.moveTo(0, y);
    fgCtx.lineTo(w, y);
  });
  fgCtx.stroke();
}

drawBg();

