// Character Voice Agent - frontend.
//
// Milestone 1: the character appears (idle, blink, intro).
// Milestone 2: it thinks  (WebSocket chat with Nova Lite).
// Milestone 3: it speaks  (Polly audio + viseme lip sync + speech bubble).
// Milestone 4: it feels & moves (emotion on face, animation state machine, Dance).
// Milestone 5: greeting + character.json theme/voice.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { loadMixamoAnimation } from "/loadMixamoAnimation.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AVATAR_URL = "/avatars/CoolAlien.vrm";
const ANIMATION_URLS = {
  idle: "/animations/idle.fbx",
  thinking: "/animations/thinking.fbx",
  talking: "/animations/talking.fbx",
  dance: "/animations/dance.fbx",
  "fall-flat": "/animations/fall-flat.fbx",
  "stand-up": "/animations/stand-up.fbx",
};
const DANCE_MUSIC_URL = "/music/dance.mp3";

const EMOTIONS = ["happy", "angry", "sad", "relaxed"]; // "neutral" = all zero

// viseme letter -> mouth blendshape weights
const VISEME_MAP = {
  a: { aa: 1.0 },
  "@": { aa: 0.5 },
  e: { ee: 0.8 },
  E: { ee: 0.6, aa: 0.3 },
  i: { ih: 0.8 },
  o: { oh: 0.9 },
  O: { oh: 0.7, aa: 0.3 },
  u: { ou: 0.9 },
  t: { ih: 0.3 },
  s: { ih: 0.3 },
  T: { ih: 0.3 },
  S: { ou: 0.3, ih: 0.2 },
  k: { aa: 0.3 },
  r: { ou: 0.3 },
  f: { ih: 0.2 },
};
const MOUTH_SHAPES = ["aa", "ih", "ou", "ee", "oh"];

// ---------------------------------------------------------------------------
// Scene / camera / renderer
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  20
);
camera.position.set(0, 1.0, 4.0);
camera.lookAt(new THREE.Vector3(0, 0.75, 0));

const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(1, 2, 2);
scene.add(dirLight);
scene.add(new THREE.AmbientLight(0xffffff, 1.2));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let vrm = null;
let mixer = null;
const actions = {};
let currentAction = null;
const clock = new THREE.Clock();

let started = false;
let introPlaying = false;
let isDancing = false;
let waiting = false; // waiting for a reply (thinking)

// Blink.
let nextBlinkAt = 1 + Math.random() * 4;
let blinkElapsed = 0;
let blinkPhase = null;
let blinkT = 0;

// Speech / lip sync.
let audioCtx = null;
let currentSource = null;
let speaking = false;
let currentVisemes = null;
let speechStartTime = 0;
let currentEmotion = "neutral";

const loadingEl = document.getElementById("loading");
const bubbleEl = document.getElementById("bubble");
const msgInput = document.getElementById("msg");
const sendBtn = document.getElementById("send-btn");
const danceBtn = document.getElementById("dance-btn");

// ---------------------------------------------------------------------------
// Load VRM + animations
// ---------------------------------------------------------------------------
const gltfLoader = new GLTFLoader();
gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

async function init() {
  const gltf = await gltfLoader.loadAsync(AVATAR_URL);
  vrm = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((obj) => (obj.frustumCulled = false));
  scene.add(vrm.scene);

  mixer = new THREE.AnimationMixer(vrm.scene);

  await Promise.all(
    Object.entries(ANIMATION_URLS).map(async ([name, url]) => {
      try {
        const clip = await loadMixamoAnimation(url, vrm);
        actions[name] = mixer.clipAction(clip);
      } catch (err) {
        console.error(`Failed to load animation "${name}":`, err);
      }
    })
  );

  loadingEl.classList.add("hidden");
  // Start lying on the floor (last frame of fall-flat), waiting for the click.
  poseFallen();
}

// Freeze the character on the ground using the final frame of fall-flat.
function poseFallen() {
  const action = actions["fall-flat"];
  if (!action) {
    playLoop("idle");
    return;
  }
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.enabled = true;
  action.setEffectiveWeight(1.0);
  // Jump to the end of the clip so it shows the fully-fallen pose, frozen.
  action.time = action.getClip().duration;
  action.play();
  currentAction = action;
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------
function playLoop(name, fade = 0.4) {
  const action = actions[name];
  if (!action) return null;
  if (currentAction === action) return action;
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = false;
  action.enabled = true;
  action.setEffectiveWeight(1.0);
  action.fadeIn(fade);
  action.play();
  if (currentAction && currentAction !== action) {
    currentAction.crossFadeTo(action, fade, false);
  }
  currentAction = action;
  return action;
}

function playOnce(name, { startAt = 0, timeScale = 1 } = {}) {
  return new Promise((resolve) => {
    const action = actions[name];
    if (!action) return resolve();
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    action.setEffectiveWeight(1.0);
    action.timeScale = timeScale;
    if (startAt) action.time = startAt;
    action.play();
    if (currentAction && currentAction !== action) {
      currentAction.crossFadeTo(action, 0.4, false);
    }
    currentAction = action;
    const onFinished = (e) => {
      if (e.action !== action) return;
      mixer.removeEventListener("finished", onFinished);
      action.timeScale = 1;
      resolve();
    };
    mixer.addEventListener("finished", onFinished);
  });
}

async function playIntro() {
  if (introPlaying) return;
  introPlaying = true;
  try {
    // The character already lies on the floor; now it stands up.
    // stand-up starts with ~2.5s lying still, so skip ahead and speed it up.
    await playOnce("stand-up", { startAt: 2.5, timeScale: 1.6 });
  } catch (err) {
    console.error("Intro error:", err);
  } finally {
    introPlaying = false;
    if (!isDancing && !speaking) playLoop("idle");
  }
}

// Decide which looping animation reflects the current state.
function restIdleOrState() {
  if (isDancing) return;
  if (speaking) playLoop("talking");
  else if (waiting) playLoop("thinking");
  else playLoop("idle");
}

// ---------------------------------------------------------------------------
// Expressions: blink + emotion + mouth
// ---------------------------------------------------------------------------
function updateBlink(delta) {
  const em = vrm?.expressionManager;
  if (!em) return;
  if (blinkPhase === null) {
    blinkElapsed += delta;
    if (blinkElapsed >= nextBlinkAt) {
      blinkPhase = "closing";
      blinkT = 0;
      blinkElapsed = 0;
    }
  } else {
    blinkT += delta / 0.09;
    if (blinkPhase === "closing") {
      em.setValue("blink", Math.min(blinkT, 1));
      if (blinkT >= 1) {
        blinkPhase = "opening";
        blinkT = 0;
      }
    } else {
      em.setValue("blink", Math.max(1 - blinkT, 0));
      if (blinkT >= 1) {
        blinkPhase = null;
        em.setValue("blink", 0);
        nextBlinkAt = 1 + Math.random() * 4;
      }
    }
  }
}

function applyEmotion(emotion) {
  const em = vrm?.expressionManager;
  if (!em) return;
  for (const name of EMOTIONS) {
    em.setValue(name, emotion === name ? 0.7 : 0);
  }
}

function clearMouth() {
  const em = vrm?.expressionManager;
  if (!em) return;
  for (const s of MOUTH_SHAPES) em.setValue(s, 0);
}

function updateLipSync() {
  const em = vrm?.expressionManager;
  if (!em || !speaking || !currentVisemes || !audioCtx) return;
  const now =
    (audioCtx.currentTime - speechStartTime - (audioCtx.outputLatency || 0)) *
    1000;
  // last viseme with time <= now
  let active = null;
  for (const v of currentVisemes) {
    if (v.time <= now) active = v;
    else break;
  }
  for (const s of MOUTH_SHAPES) em.setValue(s, 0);
  if (active) {
    const shape = VISEME_MAP[active.value];
    if (shape) for (const [k, val] of Object.entries(shape)) em.setValue(k, val);
  }
}

// ---------------------------------------------------------------------------
// Audio + speaking
// ---------------------------------------------------------------------------
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function speak(text, emotion, audioB64, visemes) {
  ensureAudioContext();

  // Show the bubble.
  bubbleEl.textContent = text;
  bubbleEl.classList.add("show");

  // Face + animation.
  currentEmotion = emotion || "neutral";
  applyEmotion(currentEmotion);

  if (!audioB64) {
    // No audio (shouldn't normally happen) — just show text briefly.
    waiting = false;
    restIdleOrState();
    setTimeout(() => bubbleEl.classList.remove("show"), 2500);
    return;
  }

  const buffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(audioB64));

  if (currentSource) {
    try {
      currentSource.stop();
    } catch {}
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);

  currentVisemes = visemes || [];
  speechStartTime = audioCtx.currentTime;
  speaking = true;
  currentSource = src;

  waiting = false;
  if (!isDancing) playLoop("talking");

  src.onended = () => {
    speaking = false;
    currentSource = null;
    currentVisemes = null;
    clearMouth();
    applyEmotion("neutral");
    bubbleEl.classList.remove("show");
    restIdleOrState();
  };

  src.start();
}

// ---------------------------------------------------------------------------
// WebSocket chat
// ---------------------------------------------------------------------------
let ws = null;

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "reply") {
      setWaiting(false);
      speak(msg.text, msg.emotion, msg.audio, msg.visemes);
    } else if (msg.type === "transcript") {
      // Live words while the user talks (Bonus A).
      if (msg.text) {
        bubbleEl.textContent = msg.text;
        bubbleEl.classList.add("show");
      } else if (!recording) {
        // Empty final transcript (likely a muted mic).
        setWaiting(false);
        bubbleEl.textContent = "I didn't catch that — is your mic on?";
        bubbleEl.classList.add("show");
        setTimeout(() => bubbleEl.classList.remove("show"), 2500);
        restIdleOrState();
      }
    } else if (msg.type === "error") {
      setWaiting(false);
      bubbleEl.textContent = msg.message || "Something went wrong. Try again.";
      bubbleEl.classList.add("show");
      setTimeout(() => bubbleEl.classList.remove("show"), 3000);
      restIdleOrState();
    }
  };

  ws.onclose = () => {
    // Try to reconnect after a short delay.
    setTimeout(connectWS, 1500);
  };
}

function setWaiting(isWaiting) {
  waiting = isWaiting;
  sendBtn.disabled = isWaiting;
  msgInput.disabled = isWaiting;
  if (isWaiting && !isDancing) playLoop("thinking");
}

function sendMessage() {
  if (waiting) return;
  const text = msgInput.value.trim().slice(0, 500);
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Sending a message stops the dance.
  if (isDancing) stopDance();

  ensureAudioContext();
  msgInput.value = "";
  setWaiting(true);
  ws.send(JSON.stringify({ type: "user_message", text }));
}

// ---------------------------------------------------------------------------
// Microphone (Bonus A): hold to talk -> stream 16kHz PCM -> Transcribe
// ---------------------------------------------------------------------------
const micBtn = document.getElementById("mic-btn");
let micStream = null;
let micNode = null;
let micSourceNode = null;
let recording = false;
let recordTimeout = null;

// The mic only works on localhost or https.
const micSupported =
  (location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1") &&
  !!navigator.mediaDevices?.getUserMedia;

if (!micSupported) {
  micBtn.classList.add("hidden");
}

async function startRecording() {
  if (recording || waiting || !micSupported) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Talking stops the dance.
  if (isDancing) stopDance();

  const ctx = ensureAudioContext();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("Mic permission denied:", err);
    bubbleEl.textContent = "I couldn't hear you — microphone blocked.";
    bubbleEl.classList.add("show");
    setTimeout(() => bubbleEl.classList.remove("show"), 2500);
    return;
  }

  await ctx.audioWorklet.addModule("/mic-worklet.js");

  recording = true;
  micBtn.classList.add("recording");
  micBtn.textContent = "● Listening…";
  if (!isDancing) playLoop("thinking");

  ws.send(JSON.stringify({ type: "start_recording" }));

  micSourceNode = ctx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(ctx, "mic-processor");
  micNode.port.onmessage = (e) => {
    if (recording && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(e.data); // binary PCM chunk
    }
  };
  micSourceNode.connect(micNode);
  // Do not connect to destination (we don't want to hear ourselves).

  // Safety: auto-stop after 30 seconds.
  recordTimeout = setTimeout(stopRecording, 30000);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove("recording");
  micBtn.textContent = "🎤 Hold to talk";
  if (recordTimeout) {
    clearTimeout(recordTimeout);
    recordTimeout = null;
  }

  try {
    micSourceNode?.disconnect();
    micNode?.disconnect();
  } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micNode = null;
  micSourceNode = null;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop_recording" }));
  }
  // The server will reply with the transcript answer; show thinking meanwhile.
  setWaiting(true);
}

// Mouse / touch: hold to talk.
micBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});
micBtn.addEventListener("mouseup", stopRecording);
micBtn.addEventListener("mouseleave", () => {
  if (recording) stopRecording();
});
micBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startRecording();
});
micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});

// Space bar: hold to talk (but not while typing in the text box).
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (document.activeElement === msgInput) return;
  if (e.repeat) return;
  e.preventDefault();
  startRecording();
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  if (document.activeElement === msgInput) return;
  e.preventDefault();
  stopRecording();
});

// ---------------------------------------------------------------------------
// Dance
// ---------------------------------------------------------------------------
let danceAudio = null;

function startDance() {
  isDancing = true;
  danceBtn.textContent = "Stop";
  playLoop("dance");
  if (!danceAudio) {
    danceAudio = new Audio(DANCE_MUSIC_URL);
    danceAudio.loop = true;
  }
  danceAudio.currentTime = 0;
  danceAudio.play().catch(() => {});
}

function stopDance() {
  isDancing = false;
  danceBtn.textContent = "Dance";
  if (danceAudio) danceAudio.pause();
  restIdleOrState();
}

function toggleDance() {
  if (isDancing) stopDance();
  else startDance();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
  if (vrm) {
    updateBlink(delta);
    updateLipSync();
    vrm.update(delta);
  }
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Character theme (background colors from character.json)
// ---------------------------------------------------------------------------
async function applyCharacterTheme() {
  try {
    const data = await (await fetch("/character")).json();
    if (Array.isArray(data.background) && data.background.length === 2) {
      document.documentElement.style.setProperty("--bg-top", data.background[0]);
      document.documentElement.style.setProperty(
        "--bg-bottom",
        data.background[1]
      );
    }
  } catch {
    /* keep default theme */
  }
}

// ---------------------------------------------------------------------------
// Start button + wiring
// ---------------------------------------------------------------------------
function wireStart() {
  const startScreen = document.getElementById("start-screen");
  const startBtn = document.getElementById("start-btn");
  const handler = async () => {
    if (started) return;
    started = true;
    startScreen.classList.add("hidden");
    ensureAudioContext();
    await playIntro();
    // Milestone 5: speak the greeting after the intro.
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "greeting" }));
    }
  };
  startBtn.addEventListener("click", handler);
  startScreen.addEventListener("click", handler);
}

sendBtn.addEventListener("click", sendMessage);
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});
danceBtn.addEventListener("click", () => {
  ensureAudioContext();
  toggleDance();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
applyCharacterTheme();
connectWS();
wireStart();
animate();
init().catch((err) => {
  console.error("Init failed:", err);
  loadingEl.textContent = "Failed to load character (see console).";
});
