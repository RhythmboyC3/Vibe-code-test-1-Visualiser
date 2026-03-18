/* BeatPulse — mic beat detector using p5.sound (ml5 included via HTML) */

let microphone;
let amplitudeAnalyzer;
let soundFile = null; // when using a local audio file
let systemStream = null; // when capturing system/tab audio via getDisplayMedia
let fft; // spectrum analyzer
let particles = [];
let lastRadius = 0;
let currentLevel = 0;
let balls = [];
let ripples = [];
let gridWarps = [];
let lastGridWarpMs = 0;
// Custom cursor tip physics
let cursorTipAngle = 0; // radians offset
let cursorTipVel = 0;   // radians/sec
let cursorTipMax = 1.3; // max tip angle in radians (~75°)

const BALL_COUNT = 13;

let beatThresholdBase = 0.06; // base level that must be exceeded to count as a beat (more sensitive)
let beatCutoff = beatThresholdBase; // dynamic cutoff that decays over time
let beatHoldMs = 75; // minimum time between detected beats
let beatDecayRate = 0.98; // how quickly the dynamic cutoff decays
let lastBeatMs = 0;

// Visual state
let pulseStrength = 0; // 0..1, decays over time, set to 1 on beat
let flashAlpha = 0; // flash overlay alpha on beat
let hueBase = 270; // purple-ish base hue for the circle

let started = false;

// Pitch-driven hue state
let currentPitchHz = 0;
let currentPitchHue = hueBase;

// Tempo estimation (BPM) from detected beats
let beatIntervals = []; // recent inter-beat intervals in ms
let estimatedBpm = 120; // smoothed BPM estimate
let tempoSpeedScale = 1; // used to scale ball speed/cap (1.0 at 120 BPM)

// Shape morphing state
const shapeOrder = ['circle', 'triangle', 'square', 'pentagon'];
let currentShapeIndex = 0;
let nextShapeIndex = 1;
let isMorphingShape = false;
let shapeMorphStartMs = 0;
let shapeMorphDurationMs = 4000; // ms for morph animation
let shapeHoldMs = 5000; // ms to hold a shape before next morph
let lastShapeChangeMs = 0;

// Shape rotation state (radians)
let shapeRotationRad = 0;
let shapeSweepAng = 0; // for rotating highlight along the edge
let shapeSpinMultiplier = 6; // global multiplier for shape spin speed

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent(document.body);
  colorMode(HSL, 360, 100, 100, 255);
  noStroke();
  noCursor();

  initBalls(BALL_COUNT);

  // Prepare audio nodes (will start on user gesture)
  microphone = new p5.AudioIn();
  amplitudeAnalyzer = new p5.Amplitude(0.95); // strong smoothing for stable envelope
  fft = new p5.FFT(0.8, 256); // smoothing, bins must map to a power-of-two fftSize

  // Start on button click per browser autoplay policies
  const startBtn = document.getElementById('startBtn');
  startBtn?.addEventListener('click', async () => {
    try {
      await userStartAudio();
    } catch (_) {
      // Some browsers already allow audio; continue
    }

    microphone.start(
      () => {
        amplitudeAnalyzer.setInput(microphone);
        try { fft.setInput(microphone); } catch (_) {}
        started = true;
        document.getElementById('ui').style.display = 'none';
      },
      (err) => {
        console.error('Mic error:', err);
        const btn = document.getElementById('startBtn');
        if (btn) btn.textContent = 'Mic permission denied — retry';
      }
    );
  });

  // System audio capture button
  const systemBtn = document.getElementById('systemBtn');

  // Removed file input handling

  // Capture system audio using screen share with audio (supported on Chrome/Edge)
  systemBtn?.addEventListener('click', async () => {
    try {
      await userStartAudio();
    } catch (_) {}

    // Stop mic/file if active
    try { microphone?.stop(); } catch (_) {}
    if (soundFile) { try { soundFile.stop(); } catch (_) {} soundFile = null; }
    if (systemStream) {
      try { systemStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      systemStream = null;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      systemStream = stream;

      // Create a MediaStreamSource and feed it into the amplitude analyzer
      const audioContext = getAudioContext();
      const source = audioContext.createMediaStreamSource(stream);

      // Mute the captured audio by routing it to a silent destination
      // (We do not connect source to destination; only to the analyzer graph)
      amplitudeAnalyzer.setInput(source);
      try { fft.setInput(source); } catch (_) {}
      started = true;
      document.getElementById('ui').style.display = 'none';
    } catch (err) {
      console.error('System audio capture error:', err);
    }
  });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  clampBallsToCanvas();
}

function mousePressed() {
  // Create ripples at click location
  if (started) {
    spawnRipple(mouseX, mouseY);
  }
  // Tip the cursor regardless of start state
  cursorTipVel -= 12.0;
  // Click-driven grid warp
  spawnGridWarp(mouseX, mouseY);
}

function draw() {
  background(0);

  // Use live level if started, otherwise idle level
  const level = started ? amplitudeAnalyzer.getLevel() : 0.0;

  // Beat detection (only when audio started)
  if (started) {
    const now = millis();
    if (now > lastBeatMs + beatHoldMs) {
      if (level > beatCutoff && level > beatThresholdBase) {
        onBeat(level);
      } else {
        beatCutoff = max(beatCutoff * beatDecayRate, beatThresholdBase);
      }
    }
  }

  // Decay visuals
  pulseStrength = max(0, pulseStrength * 0.92 - 0.002);
  flashAlpha = max(0, flashAlpha * 0.9 - 1);

  // Circle radius eases with pulseStrength and current level
  const easedPulse = easeOutCubic(pulseStrength);
  const baseRadius = min(width, height) * 0.18;
  const radius = baseRadius * (1 + easedPulse * 0.6 + level * 0.8);
  lastRadius = radius;
  currentLevel = level;

  // Subtle background gradient
  drawRadialGradient(width / 2, height / 2, radius * 1.8, color(0, 0, 4), color(0, 0, 0));

  // Background dot grid that warps with the beat
  drawWarpingDotGrid();

  // Mouse-generated pulse waves
  updateAndDrawRipples();

  // Continuous grid warp while mouse is held
  if (mouseIsPressed) {
    const nowHold = millis();
    if (nowHold - lastGridWarpMs > 30) { // throttle to ~33 Hz
      spawnGridWarp(mouseX, mouseY);
      lastGridWarpMs = nowHold;
    }
  }

  // Update shape morph timing
  updateShapeMorph();

  // Main pulsing shape (morphs over time)
  drawMorphingShape(radius, level);

  // Futuristic orbiting visual lines
  drawOrbitingLines(radius);

  // Circular spectrum bars around the circle
  drawSpectrumRing(radius);

  // Update pitch hue after FFT analysis
  updatePitchFromFFT();

  // Bouncing balls
  updateAndDrawBalls();

  // Particles
  updateAndDrawParticles();

  // Beat flash overlay
  if (flashAlpha > 1) {
    fill(0, 0, 100, flashAlpha * 0.3);
    rect(0, 0, width, height);
  }

  // Dim visuals behind the start UI when not started
  if (!started) {
    fill(0, 0, 0, 90);
    rect(0, 0, width, height);
  }

  // Custom cursor on top
  drawTriangleCursor();
}

function onBeat(level) {
  const nowMs = millis();
  // Record tempo from inter-beat interval and update speed scale
  recordBeatInterval(nowMs);
  lastBeatMs = nowMs;
  beatCutoff = level * 1.25; // set a new cutoff above the current peak
  pulseStrength = 1;
  flashAlpha = 140;
  // Emit particles from the ring
  spawnParticles(80, lastRadius * 1.05);

  // Music-driven ripples
  const cx = width / 2;
  const cy = height / 2;
  // Always spawn a central ripple on beat
  spawnRipple(cx, cy);
  // Occasionally add an extra offset ripple based on intensity
  if (level > 0.12) {
    const a = random(TWO_PI);
    const r = lastRadius * random(0.0, 0.3);
    spawnRipple(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }

  // Give balls a tiny kick
  for (let i = 0; i < balls.length; i += 1) {
    const b = balls[i];
    const kick = (0.35 + level * 0.9) * tempoSpeedScale;
    const angle = random(TWO_PI);
    b.vx = b.vx * 1.05 + cos(angle) * kick;
    b.vy = b.vy * 1.05 + sin(angle) * kick;
    capBallVelocity(b);
  }
}

function drawCircle(radius, level) {
  // Circle hue follows pitch as well, with some motion
  const hueShift = (frameCount * 0.5 + level * 60) % 360;
  const h = (currentPitchHue + hueShift) % 360;
  const s = 80;
  const l = 55 + level * 20; // brighten a bit with level
  fill(h, s, l);
  ellipse(width / 2, height / 2, radius * 2, radius * 2);

  // Blinking ring on beat
  const ringOpacity = map(pulseStrength, 0, 1, 0, 180);
  if (ringOpacity > 1) {
    stroke(h, s, 85, ringOpacity);
    strokeWeight(max(2, radius * 0.05));
    noFill();
    ellipse(width / 2, height / 2, radius * 2.4, radius * 2.4);
    noStroke();
  }
}

function drawRegularPolygon(cx, cy, r, sides) {
  beginShape();
  for (let i = 0; i < sides; i += 1) {
    const a = -HALF_PI + (TWO_PI * i) / sides;
    vertex(cx + cos(a) * r, cy + sin(a) * r);
  }
  endShape(CLOSE);
}

function drawMorphingShape(radius, level) {
  const hueShift = (frameCount * 0.5 + level * 60) % 360;
  const h = (currentPitchHue + hueShift) % 360;
  const s = 80;
  const l = 55 + level * 20;
  fill(h, s, l);

  const cx = width / 2;
  const cy = height / 2;

  // Determine current morph progress 0..1
  const t = getShapeMorphProgress();
  const fromShape = shapeOrder[currentShapeIndex];
  const toShape = shapeOrder[nextShapeIndex];

  // Strategy: sample N points around angle domain and lerp their radii
  const sampleCount = 160;
  push();
  translate(cx, cy);
  // Rotate shape based on tempo; base speed is ~1 rev/20s at 120 BPM
  const baseRevPerSec = 1 / 20;
  const angularVel = baseRevPerSec * TWO_PI * tempoSpeedScale * shapeSpinMultiplier; // rad/sec
  const dt = deltaTime / 1000;
  shapeRotationRad = (shapeRotationRad + angularVel * dt) % TWO_PI;
  rotate(shapeRotationRad);
  // Build outline points once
  const pts = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const ang = -HALF_PI + (TWO_PI * i) / sampleCount;
    const rFrom = supportRadius(fromShape, ang, radius);
    const rTo = supportRadius(toShape, ang, radius);
    const rNow = lerp(rFrom, rTo, t);
    pts.push({ x: Math.cos(ang) * rNow, y: Math.sin(ang) * rNow, ang, r: rNow });
  }
  // Filled core
  beginShape();
  for (let i = 0; i < sampleCount; i += 1) {
    vertex(pts[i].x, pts[i].y);
  }
  endShape(CLOSE);

  // Neon outer glow
  push();
  blendMode(ADD);
  noFill();
  for (let g = 0; g < 4; g += 1) {
    const alphaGlow = (90 - g * 18) * 0.5; // half the glow intensity
    const weight = max(1.5, radius * (0.12 - g * 0.025));
    stroke(h, 90, 85, alphaGlow);
    strokeWeight(weight);
    beginShape();
    for (let i = 0; i < sampleCount; i += 1) {
      vertex(pts[i].x, pts[i].y);
    }
    endShape(CLOSE);
  }
  pop();

  // Rotating highlight sweep along the edge
  shapeSweepAng = (shapeSweepAng + TWO_PI * 0.25 * dt * tempoSpeedScale) % TWO_PI;
  const sweepIdx = Math.floor(((shapeSweepAng + TWO_PI) % TWO_PI) / TWO_PI * sampleCount) % sampleCount;
  const span = Math.max(2, Math.floor(sampleCount * 0.02));
  stroke(h, 100, 95, 220);
  strokeWeight(max(2, radius * 0.06));
  noFill();
  for (let k = -span; k <= span; k += 1) {
    const i0 = (sweepIdx + k + sampleCount) % sampleCount;
    const i1 = (i0 + 1) % sampleCount;
    line(pts[i0].x, pts[i0].y, pts[i1].x, pts[i1].y);
  }

  // Inner circuit lines
  const circuitCount = 6;
  const phase = millis() * 0.0015 * tempoSpeedScale;
  stroke(h, 70, 85, 160);
  strokeWeight(max(1.5, radius * 0.01));
  for (let j = 0; j < circuitCount; j += 1) {
    const a = -HALF_PI + (TWO_PI * j) / circuitCount + phase;
    const rEdge = lerp(
      supportRadius(fromShape, a, radius),
      supportRadius(toShape, a, radius),
      t
    );
    const rIn = rEdge * 0.78;
    line(Math.cos(a) * rIn, Math.sin(a) * rIn, Math.cos(a) * rEdge, Math.sin(a) * rEdge);
  }
  pop();

  // Ring accent on beat
  const ringOpacity = map(pulseStrength, 0, 1, 0, 180);
  if (ringOpacity > 1) {
    stroke(h, s, 85, ringOpacity);
    strokeWeight(max(2, radius * 0.05));
    noFill();
    ellipse(cx, cy, radius * 2.4, radius * 2.4);
    noStroke();
  }
}

// Returns the radial distance of a shape's boundary at angle ang
function supportRadius(shape, ang, baseR) {
  switch (shape) {
    case 'circle':
      return baseR;
    case 'triangle':
      return polygonSupportRadius(3, ang, baseR);
    case 'square':
      return polygonSupportRadius(4, ang, baseR);
    case 'pentagon':
      return polygonSupportRadius(5, ang, baseR);
    default:
      return baseR;
  }
}

// Support radius for a regular N-gon centered at origin, circumscribed by baseR
function polygonSupportRadius(sides, ang, baseR) {
  // Align one vertex to top (-HALF_PI)
  const a = ang;
  const k = Math.PI / sides;
  // Distance to edge at angle a for a circumscribed polygon of radius baseR
  // r(ang) = baseR * cos(k) / cos(mod(ang, 2k) - k)
  const m = ((a % (2 * k)) + 2 * k) % (2 * k); // wrap into [0, 2k)
  const denom = Math.cos(m - k);
  const safeDenom = Math.max(0.0001, Math.abs(denom)) * Math.sign(denom);
  return baseR * Math.cos(k) / safeDenom;
}

function updateShapeMorph() {
  const now = millis();
  if (!isMorphingShape) {
    if (now - lastShapeChangeMs > shapeHoldMs) {
      isMorphingShape = true;
      shapeMorphStartMs = now;
      nextShapeIndex = (currentShapeIndex + 1) % shapeOrder.length;
    }
  } else {
    const t = (now - shapeMorphStartMs) / shapeMorphDurationMs;
    if (t >= 1) {
      // Finish morph
      currentShapeIndex = nextShapeIndex;
      lastShapeChangeMs = now;
      isMorphingShape = false;
    }
  }
}

function getShapeMorphProgress() {
  if (!isMorphingShape) return 0;
  const now = millis();
  const t = (now - shapeMorphStartMs) / shapeMorphDurationMs;
  // Ease for smoother morph
  return constrain(1 - pow(1 - constrain(t, 0, 1), 3), 0, 1);
}

function drawRadialGradient(cx, cy, r, innerCol, outerCol) {
  // Simple sampled radial gradient for atmosphere
  const steps = 24;
  for (let i = steps; i >= 1; i -= 1) {
    const t = i / steps;
    const col = lerpColor(innerCol, outerCol, 1 - t);
    fill(col);
    ellipse(cx, cy, r * t * 2, r * t * 2);
  }
}

function easeOutCubic(x) {
  return 1 - pow(1 - x, 3);
}

function drawSpectrumRing(innerRadius) {
  if (!fft) return;
  const spectrum = fft.analyze(); // 0..255 magnitudes
  if (!spectrum || spectrum.length === 0) return;

  push();
  translate(width / 2, height / 2);
  const barCount = 64; // number of bars to draw around the circle
  const step = max(1, floor(spectrum.length / barCount));
  const maxBarLen = min(width, height) * 0.25; // max outward length
  const angleStep = TWO_PI / barCount;

  for (let i = 0; i < barCount; i += 1) {
    // Average a small slice of the spectrum for smoother bars
    let sum = 0;
    for (let j = 0; j < step; j += 1) {
      const idx = i * step + j;
      if (idx < spectrum.length) sum += spectrum[idx];
    }
    const avg = sum / max(1, step);
    const norm = avg / 255; // 0..1
    const barLen = norm * maxBarLen;

    // Color reflects pitch with index offset and pulse
    const hue = (currentPitchHue + i * 4 + pulseStrength * 40) % 360;
    stroke(hue, 80, 70, 180);
    strokeWeight(3);
    push();
    rotate(i * angleStep - HALF_PI);
    line(innerRadius * 1.05, 0, innerRadius * 1.05 + barLen, 0);
    pop();
  }
  pop();
}

// ---- Mouse pulse waves ----
function spawnRipple(x, y) {
  const hue = (currentPitchHue + random(-12, 12)) % 360;
  const maxR = min(width, height) * random(0.5, 0.9);
  const speed = random(3.0, 6.0) * (1 + currentLevel * 2.0);
  const thickness = random(6, 14);
  ripples.push({ x, y, r: 0, maxR, speed, alpha: 220, hue, thickness });
}

function updateAndDrawRipples() {
  if (ripples.length === 0) return;
  push();
  noFill();
  blendMode(ADD);
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const rp = ripples[i];
    rp.r += rp.speed;
    rp.alpha *= 0.982;
    const s = 80;
    const l = 70;
    stroke(rp.hue, s, l, rp.alpha);
    strokeWeight(rp.thickness * (1 - rp.r / max(1, rp.maxR)));
    ellipse(rp.x, rp.y, rp.r * 2, rp.r * 2);
    if (rp.r >= rp.maxR || rp.alpha <= 1) {
      ripples.splice(i, 1);
    }
  }
  pop();
}

function drawTriangleCursor() {
  const cx = mouseX;
  const cy = mouseY;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

  // Simple tipping physics (damped)
  const dt = deltaTime / 1000;
  const spring = 22.0;  // stronger spring for bouncier feel
  const damping = 5.0;  // less damping for more oscillation
  cursorTipVel += -spring * cursorTipAngle * dt;
  cursorTipVel *= Math.exp(-damping * dt);
  cursorTipAngle += cursorTipVel * dt;
  // Limit maximum tip angle
  cursorTipAngle = constrain(cursorTipAngle, -cursorTipMax, cursorTipMax);

  const base = max(3, min(width, height) * 0.008);
  const size = base * (1 + easeOutCubic(pulseStrength) * 0.45 + currentLevel * 0.35);
  const baseAng = -PI / 12; // angled pointer feel
  const hue = (currentPitchHue + 10) % 360;

  push();
  translate(cx, cy);
  rotate(baseAng + cursorTipAngle);
  // Neon-style outer glow (layered, like the main shape)
  push();
  blendMode(ADD);
  noFill();
  for (let g = 0; g < 3; g += 1) {
    const alphaGlow = 80 - g * 20;
    const weight = max(0.8, size * (0.34 - g * 0.08));
    stroke(hue, 90, 85, alphaGlow);
    strokeWeight(weight);
    triangle(0, -size, size * 0.7, size * 0.45, -size * 0.7, size * 0.45);
  }
  pop();

  // core
  noStroke();
  fill(hue, 85, 70, 230);
  triangle(0, -size, size * 0.7, size * 0.45, -size * 0.7, size * 0.45);
  pop();
}

function drawOrbitingLines(coreRadius) {
  const cx = width / 2;
  const cy = height / 2;
  const t = millis() / 1000;
  const ePulse = easeOutCubic(pulseStrength);
  const revPerSec = 1 / 14; // base speed
  const spinMul = typeof shapeSpinMultiplier !== 'undefined' ? shapeSpinMultiplier : 1;
  const angVel = TWO_PI * revPerSec * tempoSpeedScale * spinMul;
  const orbits = 5;

  push();
  translate(cx, cy);
  blendMode(ADD);
  noFill();
  for (let i = 0; i < orbits; i += 1) {
    const r = coreRadius * (1.18 + i * 0.24) * (1 + ePulse * 0.04);
    const hue = (currentPitchHue + i * 12) % 360;
    const alphaBase = 60 + ePulse * 30; // further reduced brightness
    const weight = max(1.2, coreRadius * (0.012 + i * 0.002));
    const segments = 8 + i * 2;
    const baseSpan = TWO_PI / segments;
    const phase = (i * 0.9) + t * angVel * (1 + i * 0.12);

    // soft back-glow
    stroke(hue, 85, 80, alphaBase * 0.12);
    strokeWeight(weight * 1.2);
    for (let s = 0; s < segments; s += 1) {
      const wobble = 0.35 * Math.sin(t * 1.1 + s * 1.7 + i * 0.6) * ePulse;
      const fillRatio = 0.55 + 0.25 * (0.5 + 0.5 * Math.sin(t * 1.8 + s * 1.3 + i * 0.8));
      const span = baseSpan * fillRatio;
      const start = phase + s * baseSpan + wobble - span * 0.5;
      const end = start + span;
      arc(0, 0, r * 2, r * 2, start, end);
    }

    // core broken ring segments
    stroke(hue, 95, 85, alphaBase * 0.55);
    strokeWeight(weight);
    for (let s = 0; s < segments; s += 1) {
      const wobble = 0.35 * Math.sin(t * 1.1 + s * 1.7 + i * 0.6) * ePulse;
      const fillRatio = 0.6 + 0.25 * (0.5 + 0.5 * Math.sin(t * 2.0 + s * 1.6 + i * 0.5));
      const span = baseSpan * fillRatio;
      const start = phase + s * baseSpan + wobble - span * 0.5;
      const end = start + span;
      arc(0, 0, r * 2, r * 2, start, end);
    }
  }
  pop();
}

function drawWarpingDotGrid() {
  const spacing = constrain(min(width, height) * 0.05, 24, 64);
  const dotBase = spacing * 0.22;
  const ePulse = easeOutCubic(pulseStrength);
  let warpAmp = spacing * (0.6 + currentLevel * 1.2) * ePulse;
  const time = millis() * 0.0025;
  const cx = width / 2;
  const cy = height / 2;

  noStroke();
  const hue = (currentPitchHue + 180) % 360;
  const s = 50;
  const l = 28 + currentLevel * 15;
  const alpha = 140;
  fill(hue, s, l, alpha);

  for (let y = spacing * 0.5; y < height; y += spacing) {
    for (let x = spacing * 0.5; x < width; x += spacing) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.max(1, Math.hypot(dx, dy));
      const dirx = dx / d;
      const diry = dy / d;
      const wave = Math.sin(d * 0.035 - time * 2.0);
      // Apply click-driven warp fields (read-only here; updated once per frame below)
      let extraOffx = 0;
      let extraOffy = 0;
      for (let w = gridWarps.length - 1; w >= 0; w -= 1) {
        const gw = gridWarps[w];
        const gdx = x - gw.x;
        const gdy = y - gw.y;
        const gd = Math.max(1, Math.hypot(gdx, gdy));
        const falloff = Math.max(0, 1 - gd / gw.radius);
        const spring = Math.sin(gw.phase); // oscillatory push/pull
        const push = gw.strength * falloff * falloff * spring;
        extraOffx += (gdx / gd) * push;
        extraOffy += (gdy / gd) * push;
      }
      const offx = dirx * wave * warpAmp + extraOffx;
      const offy = diry * wave * warpAmp + extraOffy;
      const size = dotBase * (1 + 0.5 * ePulse);
      ellipse(x + offx, y + offy, size, size);
    }
  }
  // Update warp fields once per frame and prune
  const dt = deltaTime / 1000;
  for (let w = gridWarps.length - 1; w >= 0; w -= 1) {
    const gw = gridWarps[w];
    gw.radius += gw.speed; // expanding ring
    gw.phase += gw.freq * dt; // spin phase for oscillation
    gw.strength *= Math.exp(-gw.damping * dt); // exponential decay
    if (gw.radius > gw.maxRadius || gw.strength < 0.35) {
      gridWarps.splice(w, 1);
    }
  }
}

function spawnGridWarp(x, y) {
  const maxR = min(width, height) * 1.2;
  const startR = min(width, height) * 0.02;
  gridWarps.push({
    x,
    y,
    radius: startR,
    maxRadius: maxR,
    speed: max(10, min(width, height) * 0.02),
    strength: 28 + currentLevel * 60,
    phase: 0,
    freq: 10 + random(6), // 10..16 rad/s
    damping: 4,
  });
}

function updatePitchFromFFT() {
  if (!fft) return;
  // Ensure we have a fresh analysis for centroid
  try { fft.analyze(); } catch (_) {}
  const hz = typeof fft.getCentroid === 'function' ? fft.getCentroid() : 0;
  if (Number.isFinite(hz) && hz > 0) {
    currentPitchHz = hz;
    const targetHue = hzToHue(hz);
    // Smooth hue to reduce flicker
    currentPitchHue = lerp(currentPitchHue, targetHue, 0.18);
  }
}

function hzToHue(hz) {
  // Map frequency to hue using a perceptual (log) scale
  const minHz = 50;
  const maxHz = 4000;
  const clamped = constrain(hz, minHz, maxHz);
  const t = (Math.log(clamped) - Math.log(minHz)) / (Math.log(maxHz) - Math.log(minHz));
  return (t * 360) % 360;
}

// --- Tempo estimation and speed scaling ---
function recordBeatInterval(nowMs) {
  if (lastBeatMs > 0) {
    const interval = nowMs - lastBeatMs;
    if (interval > 180 && interval < 1500) { // plausible 40–333 BPM
      beatIntervals.push(interval);
      if (beatIntervals.length > 8) beatIntervals.shift();
      updateTempoEstimate();
    }
  }
}

function updateTempoEstimate() {
  if (beatIntervals.length === 0) return;
  // Use median for robustness
  const sorted = [...beatIntervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const bpm = 60000 / medianMs;
  // Smooth BPM and compute speed scale relative to 120 BPM
  estimatedBpm = lerp(estimatedBpm, bpm, 0.25);
  const rel = constrain(estimatedBpm / 120, 0.5, 2.0);
  // Ease changes a bit for stability
  tempoSpeedScale = lerp(tempoSpeedScale, rel, 0.2);
}

function spawnParticles(count, ringRadius) {
  const maxParticles = 1500;
  const cx = width / 2;
  const cy = height / 2;
  for (let i = 0; i < count; i += 1) {
    const angle = random(TWO_PI);
    const jitter = random(-PI / 48, PI / 48);
    const a = angle + jitter;
    const startR = ringRadius + random(-6, 6);
    const x = cx + cos(a) * startR;
    const y = cy + sin(a) * startR;
    const speed = random(0.6, 2.6) + currentLevel * 3.0;
    const vx = cos(a) * speed + random(-0.3, 0.3);
    const vy = sin(a) * speed + random(-0.3, 0.3);
    const life = floor(random(38, 90));
    const size = random(1.5, 4.5) + currentLevel * 3;
    const hue = (hueBase + degrees(a) * 0.5 + random(-8, 8)) % 360;
    particles.push({ x, y, vx, vy, life, size, hue, alpha: 200 });
  }
  if (particles.length > maxParticles) {
    particles.splice(0, particles.length - maxParticles);
  }
}

function updateAndDrawParticles() {
  if (particles.length === 0) return;
  push();
  blendMode(ADD);
  noStroke();
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    // Integrate motion
    p.x += p.vx;
    p.y += p.vy;
    // Outward acceleration from center
    const dx = p.x - width / 2;
    const dy = p.y - height / 2;
    const distLen = max(1, sqrt(dx * dx + dy * dy));
    p.vx += (dx / distLen) * 0.02;
    p.vy += (dy / distLen) * 0.02;
    // Damping
    p.vx *= 0.985;
    p.vy *= 0.985;
    // Fade and age
    p.life -= 1;
    p.alpha = max(0, p.alpha - 2.6);
    const l = 60 + currentLevel * 35;
    fill(p.hue, 80, l, p.alpha);
    ellipse(p.x, p.y, p.size, p.size);
    if (p.life <= 0 || p.alpha <= 0) {
      particles.splice(i, 1);
    }
  }
  pop();
}


// ---- Bouncing balls ----
function initBalls(count) {
  balls.length = 0;
  const maxR = max(8, min(width, height) * 0.03);
  for (let i = 0; i < count; i += 1) {
    const baseRadius = random(max(8, maxR * 0.5), maxR);
    const x = random(baseRadius, width - baseRadius);
    const y = random(baseRadius, height - baseRadius);
    let vx = random(-2.0, 2.0);
    let vy = random(-2.0, 2.0);
    if (abs(vx) < 0.2) vx = vx < 0 ? -0.2 : 0.2;
    if (abs(vy) < 0.2) vy = vy < 0 ? -0.2 : 0.2;
    vx *= tempoSpeedScale;
    vy *= tempoSpeedScale;
    const hueOffset = random(-30, 30);
    balls.push({ x, y, vx, vy, baseRadius, radius: baseRadius, hueOffset });
  }
}

function clampBallsToCanvas() {
  for (let i = 0; i < balls.length; i += 1) {
    const b = balls[i];
    b.baseRadius = min(b.baseRadius, max(6, min(width, height) * 0.05));
    const ePulse = easeOutCubic(pulseStrength);
    const scaleNow = 1 + ePulse * 0.5 + currentLevel * 0.8;
    const rNow = b.baseRadius * scaleNow;
    b.radius = rNow;
    b.x = constrain(b.x, rNow, width - rNow);
    b.y = constrain(b.y, rNow, height - rNow);
  }
}

function updateAndDrawBalls() {
  if (balls.length === 0) return;
  const friction = 0.999; // near-elastic
  const ePulse = easeOutCubic(pulseStrength);
  for (let i = 0; i < balls.length; i += 1) {
    const b = balls[i];
    // Pulse radius with audio
    const scale = 1 + ePulse * 0.5 + currentLevel * 0.8;
    b.radius = b.baseRadius * scale;
    // Integrate
    b.x += b.vx;
    b.y += b.vy;
    // Bounce off walls
    if (b.x - b.radius < 0) { b.x = b.radius; b.vx = abs(b.vx); }
    if (b.x + b.radius > width) { b.x = width - b.radius; b.vx = -abs(b.vx); }
    if (b.y - b.radius < 0) { b.y = b.radius; b.vy = abs(b.vy); }
    if (b.y + b.radius > height) { b.y = height - b.radius; b.vy = -abs(b.vy); }
    // Gentle friction to avoid runaway speeds
    b.vx *= friction;
    b.vy *= friction;
    capBallVelocity(b);

    // Color reacts to pitch with slight per-ball offset and pulse
    const hueShift = (pulseStrength * 40) % 360;
    const h = (currentPitchHue + b.hueOffset + hueShift) % 360;
    const s = 75;
    const l = 55 + currentLevel * 25;

    noStroke();
    fill(h, s, l, 200);
    ellipse(b.x, b.y, b.radius * 2, b.radius * 2);
  }
}

function getBallMaxSpeed() {
  // Cap scales with canvas size
  return max(2.5, min(width, height) * 0.015) * tempoSpeedScale;
}

function capBallVelocity(b) {
  const maxSpeed = getBallMaxSpeed();
  const speed = Math.hypot(b.vx, b.vy);
  if (speed > maxSpeed) {
    const scale = maxSpeed / max(1e-6, speed);
    b.vx *= scale;
    b.vy *= scale;
  }
}


