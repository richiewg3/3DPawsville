import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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

// --- Player placeholder -----------------------------------------------------

// A placeholder generic low-poly humanoid figure, assembled from primitive
// geometric shapes (capsule torso, sphere head, cylinder limbs). It is only
// ever referred to generically in code.
const player = buildGenericHumanoid();
scene.add(player.group);

// Spawn above origin; the map has been centered in the GLB pipeline and its
// ground baseline is at y=0, so any reasonable height will drop onto the map.
const SPAWN = new THREE.Vector3(0, 30, 0);
player.group.position.copy(SPAWN);

// Player capsule shape used for ground/side collisions.
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const PLAYER_EYE_HEIGHT = 1.55;

// --- Third person rig -------------------------------------------------------

const yawPivot = new THREE.Object3D();
const pitchPivot = new THREE.Object3D();
yawPivot.add(pitchPivot);
scene.add(yawPivot);

// --- Input ------------------------------------------------------------------

const keys = new Set();
document.addEventListener('keydown', (e) => keys.add(e.code));
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

// --- Map loading ------------------------------------------------------------

let mapRoot = null;
const collidables = [];
let mapReady = false;

const loader = new GLTFLoader();
loader.load(
  '/assets/map.glb',
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
    mapReady = true;
    loadingEl.textContent = 'Click to play — WASD to move, Space to jump.';
  },
  (event) => {
    if (event.total) {
      const pct = ((event.loaded / event.total) * 100).toFixed(0);
      loadingEl.textContent = `Loading map: ${pct}%`;
    } else {
      loadingEl.textContent = `Loading map: ${(event.loaded / 1024 / 1024).toFixed(1)} MB`;
    }
  },
  (err) => {
    loadingEl.textContent = `Failed to load map.glb: ${err.message || err}`;
  },
);

// --- Physics state ----------------------------------------------------------

const clock = new THREE.Clock();
let verticalVelocity = 0;
let grounded = false;

const GRAVITY = 32;
const JUMP_SPEED = 11;
const WALK_SPEED = 14;
const AIR_SPEED = 9;

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();

const rayDown = new THREE.Raycaster();
const rayMove = new THREE.Raycaster();

// --- Main loop --------------------------------------------------------------

renderer.setAnimationLoop(tick);

function tick() {
  const delta = Math.min(clock.getDelta(), 0.05);
  if (mapReady) {
    applyMovement(delta);
    applyGravity(delta);
  }
  updateCamera(delta);
  renderer.render(scene, camera);
}

function applyMovement(delta) {
  const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  if (forward === 0 && strafe === 0) return;

  const speed = grounded ? WALK_SPEED : AIR_SPEED;
  const dir = tmpVec.set(strafe, 0, -forward);
  dir.normalize();
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), pointer.yaw);

  // Wall collision: raycast forward at waist height. If something is within a
  // body-radius distance, cancel horizontal movement for this frame.
  const origin = tmpVec2
    .copy(player.group.position)
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
      if (dir.lengthSq() < 0.0001) return;
      dir.normalize();
    } else {
      return;
    }
  }

  player.group.position.addScaledVector(dir, speed * delta);

  // Face the camera-relative direction of travel.
  const targetYaw = Math.atan2(dir.x, dir.z);
  player.group.rotation.y = lerpAngle(player.group.rotation.y, targetYaw, 0.25);
}

function applyGravity(delta) {
  if (grounded && keys.has('Space')) {
    verticalVelocity = JUMP_SPEED;
    grounded = false;
  } else {
    verticalVelocity -= GRAVITY * delta;
  }
  player.group.position.y += verticalVelocity * delta;

  // Ground raycast from slightly above the player's feet going straight down.
  const origin = tmpVec
    .copy(player.group.position)
    .add(new THREE.Vector3(0, 2.5, 0));
  rayDown.set(origin, new THREE.Vector3(0, -1, 0));
  rayDown.near = 0;
  rayDown.far = 60; // deep enough to catch landings from jumps / small falls
  const hits = rayDown.intersectObjects(collidables, false);

  if (hits.length > 0) {
    const groundY = hits[0].point.y;
    const feetY = player.group.position.y;
    if (feetY <= groundY + 0.02 && verticalVelocity <= 0) {
      player.group.position.y = groundY;
      verticalVelocity = 0;
      grounded = true;
      return;
    }
  } else if (player.group.position.y < -400) {
    // Safety net: if the humanoid falls into the void, respawn at the start.
    player.group.position.copy(SPAWN);
    verticalVelocity = 0;
  }

  grounded = false;
}

function updateCamera(delta) {
  yawPivot.position.copy(player.group.position).add(new THREE.Vector3(0, PLAYER_EYE_HEIGHT, 0));
  yawPivot.rotation.y = pointer.yaw;
  pitchPivot.rotation.x = pointer.pitch;

  const desired = new THREE.Vector3(0, 2.0, 5.0)
    .applyQuaternion(pitchPivot.quaternion)
    .applyQuaternion(yawPivot.quaternion)
    .add(yawPivot.position);

  // Pull the camera forward if geometry sits between it and the humanoid so
  // the third-person view doesn't get buried inside a wall.
  if (collidables.length > 0) {
    const from = yawPivot.position;
    const toDir = tmpVec.copy(desired).sub(from);
    const dist = toDir.length();
    toDir.normalize();
    rayMove.set(from, toDir);
    rayMove.near = 0;
    rayMove.far = dist;
    const hit = rayMove.intersectObjects(collidables, false);
    if (hit.length > 0) {
      desired.copy(from).addScaledVector(toDir, Math.max(hit[0].distance - 0.25, 0.8));
    }
  }

  camera.position.lerp(desired, 1 - Math.exp(-14 * delta));
  camera.lookAt(yawPivot.position);
}

// --- Helpers ---------------------------------------------------------------

function buildGenericHumanoid() {
  const group = new THREE.Group();
  group.name = 'PlayerHumanoid';
  const body = new THREE.MeshStandardMaterial({ color: 0x4da3ff, flatShading: true, roughness: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xffcc66, flatShading: true, roughness: 0.55 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.9, 6, 10), body);
  torso.position.y = 1.15;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), accent);
  head.position.y = 1.95;
  group.add(head);

  const limb = new THREE.CylinderGeometry(0.11, 0.11, 0.8, 8);
  const armL = new THREE.Mesh(limb, body);
  armL.position.set(-0.55, 1.3, 0);
  const armR = armL.clone();
  armR.position.x = 0.55;
  const legL = new THREE.Mesh(limb, body);
  legL.position.set(-0.2, 0.4, 0);
  const legR = legL.clone();
  legR.position.x = 0.2;
  group.add(armL, armR, legL, legR);

  return { group };
}

function lerpAngle(a, b, t) {
  const diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  return a + diff * t;
}
