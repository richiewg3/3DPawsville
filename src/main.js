import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loadingEl = document.getElementById('loading');
const hudEl = document.getElementById('hud');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ac7ff);
scene.fog = new THREE.Fog(0x9ac7ff, 160, 520);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setAnimationLoop(tick);
renderer.localClippingEnabled = false;
renderer.info.autoReset = true;
renderer.domElement.style.touchAction = 'none';
document.body.appendChild(renderer.domElement);

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);

const directional = new THREE.DirectionalLight(0xffffff, 1.1);
directional.position.set(90, 120, 40);
directional.castShadow = true;
directional.shadow.camera.near = 10;
directional.shadow.camera.far = 300;
directional.shadow.mapSize.set(1024, 1024);
scene.add(directional);

const clock = new THREE.Clock();
const keys = new Set();

const player = buildPlaceholderHumanoid();
scene.add(player.group);
player.group.position.set(0, 20, 0);

const yawPivot = new THREE.Object3D();
const pitchPivot = new THREE.Object3D();
yawPivot.add(pitchPivot);
scene.add(yawPivot);

let mapRoot = null;
const collidables = [];
let verticalVelocity = 0;
let grounded = false;

const pointer = {
  locked: false,
  yaw: 0,
  pitch: -0.2,
};

document.addEventListener('keydown', (e) => {
  keys.add(e.code);
});

document.addEventListener('keyup', (e) => {
  keys.delete(e.code);
});

renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointer.locked = document.pointerLockElement === renderer.domElement;
  hudEl.classList.toggle('hidden', !pointer.locked);
});

document.addEventListener('mousemove', (event) => {
  if (!pointer.locked) return;
  pointer.yaw -= event.movementX * 0.0025;
  pointer.pitch = THREE.MathUtils.clamp(pointer.pitch - event.movementY * 0.0025, -1.2, 1.2);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const rayDown = new THREE.Raycaster();
const rayForward = new THREE.Raycaster();
const raySide = new THREE.Raycaster();

loadMap();

function loadMap() {
  const loader = new GLTFLoader();
  loader.load(
    '/assets/map.glb',
    (gltf) => {
      mapRoot = gltf.scene;
      mapRoot.traverse((obj) => {
        if (obj.isMesh) {
          obj.castShadow = false;
          obj.receiveShadow = true;
          obj.frustumCulled = true;
          collidables.push(obj);
        }
      });
      scene.add(mapRoot);
      loadingEl.textContent = 'Map loaded. Click to play.';
      hudEl.classList.remove('hidden');
    },
    (event) => {
      if (!event.total) {
        loadingEl.textContent = `Loading map: ${(event.loaded / 1024 / 1024).toFixed(1)}MB`;
        return;
      }
      const pct = ((event.loaded / event.total) * 100).toFixed(0);
      loadingEl.textContent = `Loading map: ${pct}%`;
    },
    (err) => {
      loadingEl.textContent = `Failed to load map.glb (${err.message})`;
    },
  );
}

function buildPlaceholderHumanoid() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x6ec1ff, flatShading: true });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.1, 8, 12), material);
  torso.position.y = 1.35;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 14, 10), material);
  head.position.y = 2.35;
  head.castShadow = true;
  group.add(head);

  const limbGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.8, 8);
  const armL = new THREE.Mesh(limbGeo, material);
  armL.position.set(-0.62, 1.45, 0);
  const armR = armL.clone();
  armR.position.x = 0.62;
  const legL = new THREE.Mesh(limbGeo, material);
  legL.position.set(-0.24, 0.5, 0);
  const legR = legL.clone();
  legR.position.x = 0.24;

  [armL, armR, legL, legR].forEach((limb) => {
    limb.castShadow = true;
    group.add(limb);
  });

  return { group };
}

function resolveMovement(delta) {
  const moveInput = new THREE.Vector3(
    Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
    0,
    Number(keys.has('KeyS')) - Number(keys.has('KeyW')),
  );

  if (moveInput.lengthSq() > 0) {
    moveInput.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), pointer.yaw);
  }

  const moveSpeed = grounded ? 11 : 7;
  const desiredMove = moveInput.multiplyScalar(moveSpeed * delta);

  if (desiredMove.lengthSq() > 0.000001 && collidables.length > 0) {
    const origin = player.group.position.clone().add(new THREE.Vector3(0, 1.1, 0));
    const forwardDir = desiredMove.clone().normalize();
    rayForward.set(origin, forwardDir);
    rayForward.far = 0.75;

    const sideDir = new THREE.Vector3(-forwardDir.z, 0, forwardDir.x);
    raySide.set(origin, sideDir);
    raySide.far = 0.45;

    const blockers = rayForward.intersectObjects(collidables, false);
    if (blockers.length > 0) {
      desiredMove.multiplyScalar(0);
    } else {
      const sideBlockers = raySide.intersectObjects(collidables, false);
      if (sideBlockers.length > 0) desiredMove.multiplyScalar(0.5);
    }
  }

  player.group.position.add(desiredMove);
  if (moveInput.lengthSq() > 0.001) {
    player.group.rotation.y = pointer.yaw + Math.PI;
  }
}

function resolveVertical(delta) {
  const gravity = 27;
  verticalVelocity -= gravity * delta;

  if (grounded && keys.has('Space')) {
    verticalVelocity = 9;
    grounded = false;
  }

  player.group.position.y += verticalVelocity * delta;

  if (collidables.length === 0) {
    if (player.group.position.y < 1.2) {
      player.group.position.y = 1.2;
      verticalVelocity = 0;
      grounded = true;
    }
    return;
  }

  rayDown.set(player.group.position.clone().add(new THREE.Vector3(0, 2, 0)), new THREE.Vector3(0, -1, 0));
  rayDown.far = 4;
  const groundHits = rayDown.intersectObjects(collidables, false);

  if (groundHits.length > 0) {
    const targetFeetY = groundHits[0].point.y + 1.15;
    if (player.group.position.y <= targetFeetY || verticalVelocity <= 0) {
      player.group.position.y = THREE.MathUtils.lerp(player.group.position.y, targetFeetY, 0.55);
      if (Math.abs(player.group.position.y - targetFeetY) < 0.02) {
        player.group.position.y = targetFeetY;
      }
      verticalVelocity = Math.max(0, verticalVelocity);
      grounded = true;
      return;
    }
  }

  grounded = false;
}

function updateCamera(delta) {
  yawPivot.position.copy(player.group.position).add(new THREE.Vector3(0, 1.7, 0));
  yawPivot.rotation.y = pointer.yaw;
  pitchPivot.rotation.x = pointer.pitch;

  const desiredCamera = new THREE.Vector3(0, 2.2, 5.2).applyQuaternion(pitchPivot.quaternion).applyQuaternion(yawPivot.quaternion).add(yawPivot.position);
  camera.position.lerp(desiredCamera, 1 - Math.exp(-10 * delta));
  camera.lookAt(yawPivot.position);
}

function tick() {
  const delta = Math.min(clock.getDelta(), 0.05);
  resolveMovement(delta);
  resolveVertical(delta);
  updateCamera(delta);
  renderer.render(scene, camera);
}
