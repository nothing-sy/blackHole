/**
 * WebGL desktop-warp black hole + Canvas2D accretion overlay.
 */
(function (global) {
  const MAX_SWALLOW = 8;

  const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_desk;
uniform vec2 u_winSize;
uniform vec4 u_winBounds;   // x,y,w,h in display pixels
uniform vec4 u_dispBounds;  // display x,y,w,h
uniform float u_horizon;
uniform float u_strength;
uniform float u_twist;
uniform float u_time;
uniform float u_hasDesk;
uniform float u_boost;

float falloff(float r, float R) {
  float t = clamp(r / max(R, 1.0), 0.0, 1.0);
  return 1.0 - smoothstep(0.0, 1.0, t);
}

void main() {
  vec2 local = v_uv * u_winSize;
  vec2 center = u_winSize * 0.5;
  vec2 d = local - center;
  // elliptical feel slightly flattened
  float r = length(vec2(d.x, d.y / 0.92));
  float R = min(u_winSize.x, u_winSize.y) * 0.5 - 1.0;

  if (r > R) {
    discard;
  }

  // Event horizon
  float hz = u_horizon * (1.0 + u_boost * 0.08);
  if (r < hz) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float f = falloff(r, R);
  float pull = u_strength * (0.55 + u_boost * 0.75) * pow(f, 1.35);
  float ang = atan(d.y, d.x) + u_twist * pull * (0.8 + 0.4 * sin(u_time * 1.7));
  float rr = max(hz + 0.5, r * (1.0 - pull * 0.85));
  vec2 warpedLocal = center + vec2(cos(ang), sin(ang)) * rr;

  // Map window pixel → display UV
  vec2 screenPx = u_winBounds.xy + warpedLocal;
  vec2 deskUV = (screenPx - u_dispBounds.xy) / u_dispBounds.zw;
  deskUV.y = 1.0 - deskUV.y; // video frames are typically top-left origin in tex upload via video

  float edge = smoothstep(R, R - 14.0, r);
  float alpha = edge;

  if (u_hasDesk < 0.5 || deskUV.x < 0.0 || deskUV.x > 1.0 || deskUV.y < 0.0 || deskUV.y > 1.0) {
    // Fallback vignette when no capture
    float glow = smoothstep(R, hz, r) * 0.25;
    gl_FragColor = vec4(0.05, 0.02, 0.04, alpha * glow);
    return;
  }

  vec4 color = texture2D(u_desk, clamp(deskUV, 0.0, 1.0));

  // Photon-ring tint near horizon
  float ring = smoothstep(hz + 10.0, hz, r) * (0.35 + u_boost * 0.25);
  color.rgb = mix(color.rgb, vec3(1.0, 0.75, 0.35), ring * 0.55);

  // Outer fade to transparent so desktop outside circle shows through (real pixels)
  // Inside circle we paint warped capture
  gl_FragColor = vec4(color.rgb, alpha);
}`;

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function heatRGB(t) {
    // t: 0 = inner white-hot, 1 = outer deep red (Gargantua palette)
    t = Math.max(0, Math.min(1, t));
    if (t < 0.18) {
      const u = t / 0.18;
      return [255, Math.floor(255 - u * 25), Math.floor(245 - u * 90)];
    }
    if (t < 0.45) {
      const u = (t - 0.18) / 0.27;
      return [255, Math.floor(230 - u * 70), Math.floor(155 - u * 95)];
    }
    if (t < 0.75) {
      const u = (t - 0.45) / 0.3;
      return [255, Math.floor(160 - u * 70), Math.floor(60 - u * 30)];
    }
    const u = (t - 0.75) / 0.25;
    return [Math.floor(255 - u * 55), Math.floor(90 - u * 70), Math.floor(30 - u * 20)];
  }

  class BlackHole {
    constructor(glCanvas, overlayCanvas) {
      this.glCanvas = glCanvas;
      this.overlay = overlayCanvas;
      this.octx = overlayCanvas.getContext('2d');
      this.state = 'idle';
      this.time = 0;
      this.boost = 0;
      this.pulse = 0;
      this.size = 220;
      this.horizon = 26;
      this.swallows = [];
      this.wisps = this._makeWisps(520);
      this.video = null;
      this.hasDesk = false;
      this.metrics = null;
      this._collapseSpin = 1;
      this._collapseUntil = 0;
      this._raf = null;
      this._last = performance.now();
      this._captureError = null;

      this.gl = glCanvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!this.gl) {
        this._captureError = 'WebGL 不可用';
        return;
      }
      this._initGL();
    }

    _makeWisps(n) {
      const wisps = [];
      // More lensed-halo filaments so the wrap-around ring stays visible
      for (let i = 0; i < n; i++) {
        let layer;
        if (i < n * 0.42) layer = 0; // front disk
        else if (i < n * 0.88) layer = 1; // lensed far-side ring
        else layer = 2; // photon ring

        let heat;
        let rNorm;
        if (layer === 0) {
          rNorm = Math.pow(rand(0, 1), 0.65);
          heat = rNorm * 0.92;
        } else if (layer === 1) {
          rNorm = rand(0.05, 0.7);
          heat = rand(0.0, 0.4);
        } else {
          rNorm = rand(0, 0.25);
          heat = rand(0, 0.15);
        }

        wisps.push({
          layer,
          angle: rand(0, Math.PI * 2),
          rNorm,
          heat,
          length:
            layer === 0
              ? rand(0.12, 0.42) * Math.PI
              : layer === 1
                ? rand(0.08, 0.28) * Math.PI
                : rand(0.04, 0.12) * Math.PI,
          width:
            layer === 0
              ? rand(1.6, 4.2)
              : layer === 1
                ? rand(2.0, 4.5)
                : rand(1.0, 2.2),
          omega: (0.12 + (1 - heat) * 0.22) / (0.55 + heat * 1.4),
          phase: rand(0, Math.PI * 2),
          skew: rand(0.75, 1.25),
        });
      }
      return wisps;
    }

    _compile(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }

    _initGL() {
      const gl = this.gl;
      const vs = this._compile(gl.VERTEX_SHADER, VERT);
      const fs = this._compile(gl.FRAGMENT_SHADER, FRAG);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        this._captureError = '着色器链接失败';
        return;
      }
      this.prog = prog;
      this.attribs = { pos: gl.getAttribLocation(prog, 'a_pos') };
      this.uniforms = {
        desk: gl.getUniformLocation(prog, 'u_desk'),
        winSize: gl.getUniformLocation(prog, 'u_winSize'),
        winBounds: gl.getUniformLocation(prog, 'u_winBounds'),
        dispBounds: gl.getUniformLocation(prog, 'u_dispBounds'),
        horizon: gl.getUniformLocation(prog, 'u_horizon'),
        strength: gl.getUniformLocation(prog, 'u_strength'),
        twist: gl.getUniformLocation(prog, 'u_twist'),
        time: gl.getUniformLocation(prog, 'u_time'),
        hasDesk: gl.getUniformLocation(prog, 'u_hasDesk'),
        boost: gl.getUniformLocation(prog, 'u_boost'),
      };

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);
      this.quad = buf;

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    setSize(size) {
      this.size = size;
      this.horizon = 26 + ((size - 220) / (720 - 220)) * (90 - 26);
      this.glCanvas.width = size;
      this.glCanvas.height = size;
      this.overlay.width = size;
      this.overlay.height = size;
      if (this.gl) this.gl.viewport(0, 0, size, size);
      const count = size <= 280 ? 420 : size <= 480 ? 520 : 620;
      if (!this.wisps || this.wisps.length !== count) {
        this.wisps = this._makeWisps(count);
      }
    }

    setMetrics(metrics) {
      this.metrics = metrics;
    }

    async startCapture() {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            frameRate: { ideal: 30, max: 60 },
          },
        });
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        this.video = video;
        this.hasDesk = true;
        this._captureError = null;
        return true;
      } catch (err) {
        this.hasDesk = false;
        this._captureError = err?.message || '屏幕采集失败';
        return false;
      }
    }

    getCaptureError() {
      return this._captureError;
    }

    setState(state) {
      this.state = state;
      if (state === 'dragover') this.boost = Math.min(1, this.boost + 0.4);
      if (state === 'idle') this.boost = Math.max(0, this.boost - 0.15);
    }

    swallow(labels) {
      const batch = labels.slice(0, MAX_SWALLOW);
      const duration = 750;
      const started = performance.now();
      const cx = this.size / 2;
      batch.forEach((label, i) => {
        this.swallows.push({
          label: String(label || '?').slice(0, 8),
          angle: rand(0, Math.PI * 2),
          r: this.size * 0.42 + i * 4,
          startR: this.size * 0.42 + i * 4,
          born: started + i * 40,
          duration: duration + i * 50,
          spin: rand(4.5, 7.5),
          done: false,
        });
      });
      this.state = 'swallowing';
      this.boost = 1;
      this.pulse = 0.4;
      void cx;
      return new Promise((resolve) => setTimeout(resolve, duration + batch.length * 50 + 80));
    }

    flashSuccess() {
      this.pulse = 1;
      this.boost = 0.85;
      this.state = 'idle';
    }

    flashError() {
      this.pulse = 0.6;
      this.state = 'error';
      setTimeout(() => {
        if (this.state === 'error') this.state = 'idle';
      }, 900);
    }

    /** Collapse / purge visual while window shrinks to min size. */
    playCollapse(durationMs = 900) {
      this.state = 'collapsing';
      this.boost = 1;
      this.pulse = 1.2;
      this._collapseSpin = 4.2;
      this._collapseUntil = performance.now() + durationMs;
      return new Promise((resolve) => {
        setTimeout(() => {
          this._collapseSpin = 1;
          this.boost = 0.3;
          this.pulse = 0.2;
          this.state = 'idle';
          resolve();
        }, durationMs);
      });
    }

    start() {
      const loop = (now) => {
        const dt = Math.min(0.05, (now - this._last) / 1000);
        this._last = now;
        this.time += dt;
        this._update(dt);
        this._drawGL();
        this._drawOverlay();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }

    stop() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      if (this.video?.srcObject) {
        this.video.srcObject.getTracks().forEach((t) => t.stop());
      }
    }

    _update(dt) {
      const collapsing = this.state === 'collapsing';
      const diskBoost = collapsing
        ? 1.8 * (this._collapseSpin || 1)
        : this.state === 'dragover' || this.state === 'swallowing'
          ? 0.85 + this.boost * 0.35
          : 0.32 + this.boost * 0.2;
      for (const w of this.wisps) {
        // Negative → counterclockwise on screen
        w.angle -= w.omega * dt * diskBoost * (w.layer === 2 ? 0.9 : 1);
        w.phase += dt * 0.8;
      }
      if (collapsing) {
        // Keep energy high through collapse, slight flicker
        this.boost = 0.85 + 0.15 * Math.sin(this.time * 18);
        this.pulse = 0.7 + 0.5 * Math.abs(Math.sin(this.time * 12));
      } else {
        this.boost = Math.max(0, this.boost - dt * 0.22);
        this.pulse = Math.max(0, this.pulse - dt * 1.1);
      }

      const now = performance.now();
      for (const s of this.swallows) {
        if (s.done) continue;
        const t = (now - s.born) / s.duration;
        if (t < 0) continue;
        if (t >= 1) {
          s.done = true;
          s.r = 0;
          continue;
        }
        const ease = t * t;
        s.r = s.startR * (1 - ease);
        s.angle += s.spin * dt * (1 + ease * 3);
      }
      this.swallows = this.swallows.filter((s) => !s.done || now - s.born < s.duration + 100);
    }

    _drawGL() {
      const gl = this.gl;
      if (!gl || !this.prog) return;

      if (this.video && this.video.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        try {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
          this.hasDesk = true;
        } catch {
          this.hasDesk = false;
        }
      }

      gl.viewport(0, 0, this.size, this.size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.prog);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(this.attribs.pos);
      gl.vertexAttribPointer(this.attribs.pos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.uniforms.desk, 0);
      gl.uniform2f(this.uniforms.winSize, this.size, this.size);

      const m = this.metrics;
      if (m?.bounds && m?.displayBounds) {
        gl.uniform4f(
          this.uniforms.winBounds,
          m.bounds.x,
          m.bounds.y,
          m.bounds.width,
          m.bounds.height
        );
        gl.uniform4f(
          this.uniforms.dispBounds,
          m.displayBounds.x,
          m.displayBounds.y,
          m.displayBounds.width,
          m.displayBounds.height
        );
      } else {
        gl.uniform4f(this.uniforms.winBounds, 0, 0, this.size, this.size);
        gl.uniform4f(this.uniforms.dispBounds, 0, 0, this.size, this.size);
      }

      const strength =
        this.state === 'collapsing'
          ? 1.45
          : this.state === 'dragover' || this.state === 'swallowing'
            ? 1.15
            : 0.72;
      gl.uniform1f(this.uniforms.horizon, this.horizon + this.pulse * 3);
      gl.uniform1f(this.uniforms.strength, strength);
      gl.uniform1f(this.uniforms.twist, 1.25);
      gl.uniform1f(this.uniforms.time, this.time);
      gl.uniform1f(this.uniforms.hasDesk, this.hasDesk ? 1 : 0);
      gl.uniform1f(this.uniforms.boost, this.boost);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    _diskPoint(angle, rNorm, layer) {
      const CX = this.size / 2;
      const CY = this.size / 2;
      const hz = this.horizon;
      const scale = this.size / 220;

      if (layer === 2) {
        // Photon ring tightly around horizon
        const ringR = hz + 2.2 * scale + rNorm * 3.5 * scale;
        return [CX + Math.cos(angle) * ringR, CY + Math.sin(angle) * ringR];
      }

      if (layer === 1) {
        // Lensed far-side disk: near-circular halo around the event horizon
        const pole = Math.abs(Math.sin(angle));
        const ringR = hz + (6 + rNorm * 12 + pole * 3) * scale;
        // Keep it round (not flattened) — this is the wrap-around secondary image
        const sx = 0.96;
        const sy = 1.08;
        return [
          CX + Math.cos(angle) * ringR * sx,
          CY + Math.sin(angle) * ringR * sy,
        ];
      }

      // Primary accretion disk: very flat ellipse (Gargantua edge-on look)
      const inner = hz + 5 * scale;
      const outer = hz + (44 + this.boost * 8) * scale;
      const r = inner + rNorm * (outer - inner);
      const flat = 0.18;
      return [CX + Math.cos(angle) * r, CY + Math.sin(angle) * r * flat];
    }

    _drawWisp(w, alphaMul) {
      const ctx = this.octx;
      const steps = w.layer === 0 ? 16 : 11;
      const [cr, cg, cb] = heatRGB(w.heat);
      const flicker = 0.82 + 0.18 * Math.sin(w.phase + w.angle * 4);
      const scale = this.size / 220;

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = w.angle + (t - 0.5) * w.length * w.skew;
        const [x, y] = this._diskPoint(a, w.rNorm, w.layer);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      let alpha =
        (w.layer === 1 ? 0.38 : w.layer === 2 ? 0.45 : 0.36) *
        (1 - w.heat * 0.22) *
        flicker *
        alphaMul *
        (0.55 + this.boost * 0.25);

      // Lensed halo brighter at top/bottom poles (Interstellar silhouette)
      if (w.layer === 1) {
        alpha *= 0.5 + 0.55 * Math.abs(Math.sin(w.angle));
      }

      // Milder inner-disk hotspots
      if (w.layer === 0 && w.heat < 0.25) alpha *= 1.15;

      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${Math.min(1, alpha)})`;
      ctx.lineWidth = w.width * (0.7 + this.boost * 0.25) * scale;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Hot core streak on inner front-disk filaments
      if (w.layer === 0 && w.heat < 0.28) {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const a = w.angle + (t - 0.5) * w.length * 0.65;
          const [x, y] = this._diskPoint(a, w.rNorm, w.layer);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(255,252,240,${0.18 * flicker * alphaMul})`;
        ctx.lineWidth = Math.max(0.6, w.width * 0.22 * scale);
        ctx.stroke();
      }
    }

    _drawDiskGlow() {
      const ctx = this.octx;
      const CX = this.size / 2;
      const CY = this.size / 2;
      const hz = this.horizon;
      const scale = this.size / 220;
      const boost = this.boost;

      // Soft warm bloom
      const bloom = ctx.createRadialGradient(CX, CY, hz * 0.6, CX, CY, hz + 60 * scale);
      bloom.addColorStop(0, `rgba(255,210,140,${0.22 + boost * 0.16})`);
      bloom.addColorStop(0.4, `rgba(255,120,40,${0.12 + boost * 0.08})`);
      bloom.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, this.size, this.size);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Horizontal disk body glow (bright crossbar)
      const bandH = (12 + boost * 5) * scale;
      const band = ctx.createLinearGradient(CX - 120 * scale, CY, CX + 120 * scale, CY);
      band.addColorStop(0, 'rgba(100,15,5,0)');
      band.addColorStop(0.22, `rgba(255,80,20,${0.14 + boost * 0.1})`);
      band.addColorStop(0.5, `rgba(255,235,180,${0.32 + boost * 0.16})`);
      band.addColorStop(0.78, `rgba(255,80,20,${0.14 + boost * 0.1})`);
      band.addColorStop(1, 'rgba(100,15,5,0)');
      ctx.fillStyle = band;
      ctx.beginPath();
      ctx.ellipse(CX, CY, hz + 48 * scale, bandH, 0, 0, Math.PI * 2);
      ctx.fill();

      // Inner hot disk ellipse
      const innerBand = ctx.createRadialGradient(CX, CY, hz, CX, CY, hz + 22 * scale);
      innerBand.addColorStop(0, `rgba(255,245,210,${0.3 + boost * 0.18})`);
      innerBand.addColorStop(0.55, `rgba(255,160,60,${0.16 + boost * 0.1})`);
      innerBand.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = innerBand;
      ctx.beginPath();
      ctx.ellipse(CX, CY, hz + 28 * scale, bandH * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();

      // Lensed halo: full ring + brighter polar caps
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,170,80,${0.18 + boost * 0.14})`;
      ctx.lineWidth = (6 + boost * 2.5) * scale;
      ctx.ellipse(CX, CY, hz + 13 * scale, hz + 15 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,235,190,${0.4 + boost * 0.2})`;
      ctx.lineWidth = (5 + boost * 2) * scale;
      ctx.ellipse(CX, CY, hz + 12 * scale, hz + 14 * scale, 0, -Math.PI * 0.75, -Math.PI * 0.25);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(CX, CY, hz + 12 * scale, hz + 14 * scale, 0, Math.PI * 0.25, Math.PI * 0.75);
      ctx.stroke();

      ctx.restore();
    }

    _drawOverlay() {
      const ctx = this.octx;
      const S = this.size;
      const CX = S / 2;
      const CY = S / 2;
      ctx.clearRect(0, 0, S, S);

      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, S / 2 - 1, 0, Math.PI * 2);
      ctx.clip();

      this._drawDiskGlow();

      const back = [];
      const front = [];
      const photon = [];
      for (const w of this.wisps) {
        if (w.layer === 1) back.push(w);
        else if (w.layer === 2) photon.push(w);
        else front.push(w);
      }
      front.sort((a, b) => Math.sin(a.angle) - Math.sin(b.angle));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const w of back) this._drawWisp(w, 0.7);
      for (const w of front) {
        if (Math.sin(w.angle) < 0.12) this._drawWisp(w, 0.35);
      }
      ctx.restore();

      const hr = this.horizon + this.pulse * 3;
      const scale = S / 220;
      ctx.beginPath();
      ctx.fillStyle = '#000';
      ctx.arc(CX, CY, hr, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,240,200,${0.55 + this.boost * 0.2 + this.pulse * 0.1})`;
      ctx.lineWidth = 2 + this.boost;
      ctx.arc(CX, CY, hr + 1.2, 0, Math.PI * 2);
      ctx.stroke();

      // Lensing ring around the void
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,140,50,${0.28 + this.boost * 0.15})`;
      ctx.lineWidth = (10 + this.boost * 3) * scale;
      ctx.ellipse(CX, CY, hr + 11 * scale, hr + 13 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,200,110,${0.35 + this.boost * 0.15})`;
      ctx.lineWidth = (6 + this.boost * 2) * scale;
      ctx.ellipse(CX, CY, hr + 8.5 * scale, hr + 10 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,240,200,${0.5 + this.boost * 0.15})`;
      ctx.lineWidth = (3.5 + this.boost * 1.5) * scale;
      ctx.ellipse(CX, CY, hr + 7 * scale, hr + 8.2 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,250,230,${0.55})`;
      ctx.lineWidth = (5 + this.boost * 1.5) * scale;
      ctx.ellipse(CX, CY, hr + 8 * scale, hr + 10 * scale, 0, -Math.PI * 0.88, -Math.PI * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(CX, CY, hr + 8 * scale, hr + 10 * scale, 0, Math.PI * 0.12, Math.PI * 0.88);
      ctx.stroke();
      for (const w of back) this._drawWisp(w, 0.75);
      for (const w of photon) this._drawWisp(w, 0.55);
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const w of front) {
        if (Math.sin(w.angle) >= 0.12) this._drawWisp(w, 0.45);
      }
      ctx.restore();

      for (const s of this.swallows) {
        if (performance.now() < s.born) continue;
        const x = CX + Math.cos(s.angle) * s.r;
        const y = CY + Math.sin(s.angle) * s.r * 0.55;
        const sc = Math.max(0.15, s.r / s.startR);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(s.angle);
        ctx.scale(sc, sc);
        ctx.fillStyle = 'rgba(255,236,210,0.92)';
        ctx.strokeStyle = 'rgba(255,140,60,0.9)';
        ctx.lineWidth = 1;
        const w = 36;
        const h = 14;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, 3);
        else ctx.rect(-w / 2, -h / 2, w, h);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#2a1810';
        ctx.font = '9px Segoe UI, Microsoft YaHei, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.label, 0, 0);
        ctx.restore();
      }

      if (this.state === 'error') {
        ctx.fillStyle = 'rgba(180,40,40,0.18)';
        ctx.fillRect(0, 0, S, S);
      }

      ctx.restore();
    }
  }

  global.BlackHole = BlackHole;
})(window);
