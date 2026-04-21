import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

// --- DOM references ---------------------------------------------------------

const loadingEl = document.getElementById('loading');
const hudEl = document.getElementById('hud');

// --- Renderer / scene / camera ---------------------------------------------

// Aggressive fog tuned tight to the camera far-plane: the far-plane is kept
// short so distant geometry never reaches the GPU, and the fog fades anything
// that does survive culling to the background color.
const FAR_PLANE = 260;
const FOG_NEAR = 90;
const FOG_FAR = FAR_PLANE - 10;
const BACKGROUND_COLOR = 0x9ac7ff;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);
scene.fog = new THREE.Fog(BACKGROUND_COLOR, FOG_NEAR, FOG_FAR);

const camera = new THREE.PerspectiveCamera(
  68,
  window.innerWidth / window.innerHeight,
  0.2,
  FAR_PLANE,
);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;
renderer.info.autoReset = true;
renderer.domElement.style.touchAction = 'none';
document.body.appendChild(renderer.domElement);

// --- Lighting ---------------------------------------------------------------

scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2c2f3a, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(80, 120, 60);
scene.add(sun);

// --- Player (rigged dragon) -------------------------------------------------

// The custom rigged Emerald Dragonling replaces the previous procedural
// humanoid placeholder. It carries its own skeleton; baked animations are
// loaded from a separate GLB and bound to the same skeleton via the standard
// AnimationMixer pipeline. Until the GLB has finished loading, the
// `dragonPlayer.group` is an empty THREE.Group occupying the same world
// position so the existing physics / camera code can keep running.
const dragonPlayer = {
  group: new THREE.Group(),
  model: null,
  mixer: null,
  actions: {},
  currentAction: null,
  modelHeight: 1.8,
};
dragonPlayer.group.name = 'DragonPlayer';
scene.add(dragonPlayer.group);

// Initial spawn — well above the map. After the map loads we'll raycast
// downward to find the topmost solid surface and drop the player there so it
// never spawns stuck inside interior geometry.
const SPAWN = new THREE.Vector3(0, 200, 0);
dragonPlayer.group.position.copy(SPAWN);

// Player capsule shape used for ground/side collisions.
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const PLAYER_EYE_HEIGHT = 1.55;

// Animation crossfade tuning.
const FADE_DEFAULT = 0.18;
const FADE_FAST = 0.08;

// Map between user-spec animation names ("idle 6", "Jump Run", ...) and the
// actual clip names baked into the model GLB ("Idle_6", "Jump_Run", ...).
// The matching is intentionally tolerant: case-insensitive and treating any
// run of underscores / spaces as equivalent.
const ANIM_KEYS = {
  idle: 'idle 6',
  walk: 'Walking',
  run: 'Running',
  jump: 'Jump Run',
};

// --- Third person rig -------------------------------------------------------

const yawPivot = new THREE.Object3D();
const pitchPivot = new THREE.Object3D();
yawPivot.add(pitchPivot);
scene.add(yawPivot);

// --- Input ------------------------------------------------------------------

const keys = new Set();
document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR' && mapReady) {
    dragonPlayer.group.position.copy(SPAWN);
    verticalVelocity = 0;
  }
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

const pointer = { locked: false, yaw: 0, pitch: -0.15 };

renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointer.locked = document.pointerLockElement === renderer.domElement;
  hudEl.classList.toggle('hidden', !pointer.locked);
});

document.addEventListener('mousemove', (event) => {
  if (!pointer.locked) return;
  pointer.yaw -= event.movementX * 0.0022;
  pointer.pitch = THREE.MathUtils.clamp(
    pointer.pitch - event.movementY * 0.0022,
    -1.1,
    1.0,
  );
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Asset loading ----------------------------------------------------------

let mapRoot = null;
const collidables = [];
let mapReady = false;
let dragonReady = false;

const gltfLoader = new GLTFLoader();
// Append a build-time version query so browsers cannot serve a stale asset
// from an earlier (broken) pipeline run.
const version = import.meta.env?.DEV ? Date.now() : '1';
const MAP_ASSET_URL = `/assets/map.glb?v=${version}`;
const DRAGON_CHARACTER_URL = `/assets/dragon/character.glb?v=${version}`;
const DRAGON_ANIMATIONS_URL = `/assets/dragon/animations.glb?v=${version}`;

function reportLoading(text) {
  if (loadingEl) loadingEl.textContent = text;
}

function maybeAnnounceReady() {
  if (mapReady && dragonReady) {
    reportLoading(
      'Click to play — WASD move • Shift sprint • Space jump • R respawn.',
    );
  }
}

// Kick off all asset loads in parallel; the map is the one that gates physics
// readiness, the dragon is what gates animation playback.
loadMap();
loadDragon();

function loadMap() {
  gltfLoader.load(
    MAP_ASSET_URL,
    (gltf) => {
      mapRoot = gltf.scene;
      mapRoot.traverse((obj) => {
        if (obj.isMesh) {
          obj.frustumCulled = true;
          obj.castShadow = false;
          obj.receiveShadow = false;
          if (obj.geometry && !obj.geometry.boundingSphere) {
            obj.geometry.computeBoundingSphere();
          }
          collidables.push(obj);
        }
      });
      scene.add(mapRoot);

      // Find a guaranteed-open landing spot: raycast straight down from high
      // above different XZ offsets until we hit something and pick the point
      // with the largest clear vertical gap above it (i.e. a rooftop or
      // street rather than the underside of a roof).
      const spawn = pickSpawnPoint();
      SPAWN.copy(spawn);
      dragonPlayer.group.position.copy(spawn);
      verticalVelocity = 0;

      mapReady = true;
      maybeAnnounceReady();
    },
    (event) => {
      if (mapReady) return;
      if (event.total) {
        const pct = ((event.loaded / event.total) * 100).toFixed(0);
        reportLoading(`Loading map: ${pct}%`);
      } else {
        reportLoading(
          `Loading map: ${(event.loaded / 1024 / 1024).toFixed(1)} MB`,
        );
      }
    },
    (err) => {
      reportLoading(`Failed to load map.glb: ${err.message || err}`);
    },
  );
}

async function loadDragon() {
  try {
    const [characterGltf, animationsGltf] = await Promise.all([
      gltfLoader.loadAsync(DRAGON_CHARACTER_URL),
      gltfLoader.loadAsync(DRAGON_ANIMATIONS_URL),
    ]);

    // SkeletonUtils.clone preserves the skinned-mesh bone bindings so the
    // model still animates when re-parented; a plain `.clone()` would share
    // and break the skeleton references.
    const model = cloneSkinned(characterGltf.scene);
    model.traverse((obj) => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        obj.frustumCulled = false; // skeletal bounds are unreliable post-skin
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });

    // Compute the model's natural height in its bind pose so we can scale it
    // to match the gameplay-defined PLAYER_HEIGHT and the city scale.
    const naturalBox = new THREE.Box3().setFromObject(model);
    const naturalSize = new THREE.Vector3();
    naturalBox.getSize(naturalSize);
    const naturalHeight = Math.max(naturalSize.y, 0.001);
    const scale = PLAYER_HEIGHT / naturalHeight;
    model.scale.setScalar(scale);

    // Re-measure after scaling to align the feet exactly with `group.position`
    // and to know the in-world model height for camera framing.
    model.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(model);
    model.position.y -= scaledBox.min.y;
    dragonPlayer.modelHeight = scaledBox.max.y - scaledBox.min.y;

    dragonPlayer.group.add(model);
    dragonPlayer.model = model;

    // Animation mixer is bound to the model root: every clip's track names
    // (e.g. "Hips.position") resolves against the cloned skeleton because
    // SkeletonUtils.clone keeps the bone hierarchy intact.
    const mixer = new THREE.AnimationMixer(model);
    dragonPlayer.mixer = mixer;

    const clips = animationsGltf.animations;
    for (const [stateKey, requestedName] of Object.entries(ANIM_KEYS)) {
      const clip = findClip(clips, requestedName);
      if (!clip) {
        console.warn(
          `[dragon] Missing animation clip for "${requestedName}"; available:`,
          clips.map((c) => c.name),
        );
        continue;
      }
      const action = mixer.clipAction(clip);
      action.enabled = true;
      action.setEffectiveWeight(0);
      action.play();
      dragonPlayer.actions[stateKey] = action;
    }

    // Boot into the idle clip at full weight so the model is never stuck in
    // an unblended T-pose for a frame.
    const idle = dragonPlayer.actions.idle;
    if (idle) {
      idle.setEffectiveWeight(1);
      dragonPlayer.currentAction = idle;
    }

    dragonReady = true;
    maybeAnnounceReady();
  } catch (err) {
    console.error('[dragon] Failed to load model/animations', err);
    reportLoading(`Failed to load dragon: ${err.message || err}`);
  }
}

function findClip(clips, requestedName) {
  const norm = (s) => s.toLowerCase().replace(/[\s_]+/g, '');
  const target = norm(requestedName);
  return (
    clips.find((c) => norm(c.name) === target) ||
    clips.find((c) => norm(c.name).includes(target)) ||
    null
  );
}

// --- Physics state ----------------------------------------------------------

const clock = new THREE.Clock();
let verticalVelocity = 0;
let grounded = false;
let lastJumpHeld = false;

const GRAVITY = 32;
const JUMP_SPEED = 11;
const WALK_SPEED = 6;
const RUN_SPEED = 11;
const AIR_SPEED = 5;

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();

const rayDown = new THREE.Raycaster();
const rayMove = new THREE.Raycaster();

// --- Main loop --------------------------------------------------------------

renderer.setAnimationLoop(tick);

function tick() {
  const delta = Math.min(clock.getDelta(), 0.05);
  let isMoving = false;
  let isSprinting = false;
  if (mapReady) {
    const moveResult = applyMovement(delta);
    isMoving = moveResult.moved;
    isSprinting = moveResult.sprinting;
    applyGravity(delta);
  }
  updateAnimation(delta, isMoving, isSprinting);
  updateCamera(delta);
  renderer.render(scene, camera);
}

function applyMovement(delta) {
  const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const sprintHeld = keys.has('ShiftLeft') || keys.has('ShiftRight');
  // Sprint per spec is "Shift + W" — only forward holds qualify, otherwise the
  // "Running" clip would fire when strafing or running backwards which would
  // look wrong.
  const sprinting = sprintHeld && forward > 0;

  if (forward === 0 && strafe === 0) return { moved: false, sprinting: false };

  const speed = grounded ? (sprinting ? RUN_SPEED : WALK_SPEED) : AIR_SPEED;
  const dir = tmpVec.set(strafe, 0, -forward);
  dir.normalize();
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), pointer.yaw);

  // Wall collision: raycast forward at waist height. If something is within a
  // body-radius distance, cancel horizontal movement for this frame.
  const origin = tmpVec2
    .copy(dragonPlayer.group.position)
    .add(new THREE.Vector3(0, PLAYER_HEIGHT * 0.55, 0));
  rayMove.set(origin, dir);
  rayMove.near = 0;
  rayMove.far = PLAYER_RADIUS + speed * delta + 0.05;
  const hit = rayMove.intersectObjects(collidables, false);
  if (hit.length > 0) {
    // Allow sliding along the hit surface by projecting the movement vector
    // onto the tangent plane of the face normal.
    const n = hit[0].face && hit[0].face.normal
      ? hit[0].face.normal.clone().transformDirection(hit[0].object.matrixWorld)
      : null;
    if (n) {
      dir.addScaledVector(n, -dir.dot(n));
      if (dir.lengthSq() < 0.0001) return { moved: true, sprinting };
      dir.normalize();
    } else {
      return { moved: true, sprinting };
    }
  }

  dragonPlayer.group.position.addScaledVector(dir, speed * delta);

  // Face the camera-relative direction of travel.
  const targetYaw = Math.atan2(dir.x, dir.z);
  dragonPlayer.group.rotation.y = lerpAngle(
    dragonPlayer.group.rotation.y,
    targetYaw,
    0.25,
  );
  return { moved: true, sprinting };
}

function applyGravity(delta) {
  if (grounded && keys.has('Space')) {
    verticalVelocity = JUMP_SPEED;
    grounded = false;
  } else {
    verticalVelocity -= GRAVITY * delta;
  }
  dragonPlayer.group.position.y += verticalVelocity * delta;

  // Ground raycast from slightly above the player's feet going straight down.
  // `far` is generous so a fall from the initial skydive spawn (y≈200) still
  // finds a rooftop to snap to on the first frame contact.
  const origin = tmpVec
    .copy(dragonPlayer.group.position)
    .add(new THREE.Vector3(0, 2.5, 0));
  rayDown.set(origin, new THREE.Vector3(0, -1, 0));
  rayDown.near = 0;
  rayDown.far = 400;
  const hits = rayDown.intersectObjects(collidables, false);

  if (hits.length > 0) {
    const groundY = hits[0].point.y;
    const feetY = dragonPlayer.group.position.y;
    if (feetY <= groundY + 0.02 && verticalVelocity <= 0) {
      dragonPlayer.group.position.y = groundY;
      verticalVelocity = 0;
      grounded = true;
      return;
    }
  } else if (dragonPlayer.group.position.y < -50) {
    dragonPlayer.group.position.copy(SPAWN);
    verticalVelocity = 0;
  }

  grounded = false;
}

// --- Animation state machine -----------------------------------------------

function updateAnimation(delta, isMoving, isSprinting) {
  if (dragonPlayer.mixer) dragonPlayer.mixer.update(delta);
  if (!dragonPlayer.actions || !dragonPlayer.currentAction) return;

  const jumpHeld = keys.has('Space');
  const jumpPressed = jumpHeld && !lastJumpHeld;
  lastJumpHeld = jumpHeld;

  const a = dragonPlayer.actions;

  let nextKey = 'idle';
  if (!grounded) {
    nextKey = 'jump';
  } else if (isMoving) {
    nextKey = isSprinting ? 'run' : 'walk';
  }

  // Force-restart the jump clip whenever the player pushes Space again so a
  // tap-tap-tap rhythm visibly retriggers the takeoff motion.
  if (jumpPressed && a.jump) {
    a.jump.reset();
  }

  const next = a[nextKey];
  if (!next || next === dragonPlayer.currentAction) return;

  crossfadeTo(next, nextKey === 'jump' ? FADE_FAST : FADE_DEFAULT);
}

function crossfadeTo(nextAction, duration) {
  const prev = dragonPlayer.currentAction;
  if (prev === nextAction) return;
  nextAction.enabled = true;
  nextAction.setEffectiveTimeScale(1);
  nextAction.setEffectiveWeight(1);
  if (prev) {
    nextAction.crossFadeFrom(prev, duration, true);
  } else {
    nextAction.fadeIn(duration);
  }
  nextAction.play();
  dragonPlayer.currentAction = nextAction;
}

// --- Camera -----------------------------------------------------------------

const CAMERA_OFFSET = new THREE.Vector3(0, 1.6, 4.6);
const CAMERA_MIN_DIST = 1.6; // never get closer than this to the player

function updateCamera(delta) {
  // Track a point near the upper torso / head of the dragon so the framing
  // matches a typical third-person follow camera and never clips through the
  // model when the camera is pulled in tight.
  const trackHeight =
    Math.max(dragonPlayer.modelHeight, PLAYER_HEIGHT) * 0.78;
  yawPivot.position
    .copy(dragonPlayer.group.position)
    .add(new THREE.Vector3(0, trackHeight, 0));
  yawPivot.rotation.y = pointer.yaw;
  pitchPivot.rotation.x = pointer.pitch;

  const desired = CAMERA_OFFSET.clone()
    .applyQuaternion(pitchPivot.quaternion)
    .applyQuaternion(yawPivot.quaternion)
    .add(yawPivot.position);

  // Pull the camera toward the player if geometry would otherwise sit between
  // them — but never closer than CAMERA_MIN_DIST so the dragon cannot collapse
  // into the lens when the player stands against a wall.
  if (collidables.length > 0) {
    const from = yawPivot.position;
    const toDir = tmpVec.copy(desired).sub(from);
    const fullDist = toDir.length();
    toDir.normalize();
    rayMove.set(from, toDir);
    rayMove.near = 0;
    rayMove.far = fullDist;
    const hit = rayMove.intersectObjects(collidables, false);
    if (hit.length > 0) {
      const safeDist = Math.max(CAMERA_MIN_DIST, hit[0].distance - 0.3);
      desired.copy(from).addScaledVector(toDir, safeDist);
    }
  }

  camera.position.lerp(desired, 1 - Math.exp(-18 * delta));
  camera.lookAt(yawPivot.position);
}

// --- Helpers ---------------------------------------------------------------

function lerpAngle(a, b, t) {
  const diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  return a + diff * t;
}

function pickSpawnPoint() {
  // Raycast from high above a grid of candidate XZ positions; pick the first
  // hit whose clear sky (next face above) is tallest. Falls back to origin.
  const caster = new THREE.Raycaster();
  caster.far = 500;
  const down = new THREE.Vector3(0, -1, 0);
  const candidates = [];
  const radii = [0, 10, 20, 40];
  for (const r of radii) {
    const steps = r === 0 ? 1 : 8;
    for (let i = 0; i < steps; i += 1) {
      const theta = (i / steps) * Math.PI * 2;
      candidates.push([Math.cos(theta) * r, Math.sin(theta) * r]);
    }
  }

  let best = null;
  for (const [x, z] of candidates) {
    caster.set(new THREE.Vector3(x, 300, z), down);
    const hits = caster.intersectObjects(collidables, false);
    if (hits.length === 0) continue;
    // Use the *first* (topmost) hit. Prefer the candidate whose topmost
    // surface is highest — that puts us on a rooftop or open street rather
    // than under geometry.
    const top = hits[0];
    if (!best || top.point.y > best.point.y) {
      best = top;
    }
  }

  if (best) {
    return new THREE.Vector3(best.point.x, best.point.y + 0.1, best.point.z);
  }
  return new THREE.Vector3(0, 60, 0);
}
