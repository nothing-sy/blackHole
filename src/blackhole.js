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
    t = Math.max(0, Math.min(1, t));
    if (t < 0.25) {
      const u = t / 0.25;
      return [255, Math.floor(255 - u * 40), Math.floor(230 - u * 150)];
    }
    if (t < 0.55) {
      const u = (t - 0.25) / 0.3;
      return [255, Math.floor(215 - u * 90), Math.floor(80 - u * 50)];
    }
    const u = (t - 0.55) / 0.45;
    return [Math.floor(255 - u * 40), Math.floor(125 - u * 95), Math.floor(30 - u * 20)];
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
      this.wisps = this._makeWisps(160);
      this.video = null;
      this.hasDesk = false;
      this.metrics = null;
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
      for (let i = 0; i < n; i++) {
        const layer = i < n * 0.55 ? 0 : i < n * 0.88 ? 1 : 2;
        const heat = layer === 2 ? rand(0, 0.2) : rand(0.05, 0.95);
        wisps.push({
          layer,
          angle: rand(0, Math.PI * 2),
          r: layer === 2 ? 1 : 1.4 + heat * 1.6,
          heat,
          length: rand(0.08, 0.28) * Math.PI,
          width: layer === 2 ? rand(1.2, 2.4) : rand(1.4, 3.6),
          omega: (0.35 + (1 - heat) * 0.9) / (0.6 + heat * 1.4),
          phase: rand(0, Math.PI * 2),
          skew: rand(0.85, 1.15),
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
      const diskBoost =
        this.state === 'dragover' || this.state === 'swallowing' ? 2.4 + this.boost : 1 + this.boost * 0.7;
      for (const w of this.wisps) {
        w.angle += w.omega * dt * diskBoost * (w.layer === 2 ? 1.4 : 1);
        w.phase += dt * 2;
      }
      this.boost = Math.max(0, this.boost - dt * 0.22);
      this.pulse = Math.max(0, this.pulse - dt * 1.1);

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
        this.state === 'dragover' || this.state === 'swallowing' ? 1.15 : 0.72;
      gl.uniform1f(this.uniforms.horizon, this.horizon + this.pulse * 3);
      gl.uniform1f(this.uniforms.strength, strength);
      gl.uniform1f(this.uniforms.twist, 1.25);
      gl.uniform1f(this.uniforms.time, this.time);
      gl.uniform1f(this.uniforms.hasDesk, this.hasDesk ? 1 : 0);
      gl.uniform1f(this.uniforms.boost, this.boost);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    _diskPoint(angle, rFactor, layer) {
      const CX = this.size / 2;
      const CY = this.size / 2;
      const baseR = this.horizon + 8;
      const r = baseR + rFactor * (this.size * 0.22);
      const flat = 0.28;
      let x;
      let y;
      if (layer === 1) {
        const ringR = this.horizon + 7 + rFactor * 4;
        x = Math.sin(angle) * ringR * 0.92;
        y = -Math.cos(angle) * ringR * 1.05;
      } else if (layer === 2) {
        const ringR = this.horizon + 5;
        x = Math.cos(angle) * ringR;
        y = Math.sin(angle) * ringR;
      } else {
        x = Math.cos(angle) * r;
        y = Math.sin(angle) * r * flat;
      }
      return [CX + x, CY + y];
    }

    _drawWisp(w, alphaMul) {
      const ctx = this.octx;
      const steps = 10;
      const [cr, cg, cb] = heatRGB(w.heat);
      const flicker = 0.85 + 0.15 * Math.sin(w.phase + w.angle * 3);
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = w.angle + (t - 0.5) * w.length * w.skew;
        const [x, y] = this._diskPoint(a, w.r, w.layer);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const alpha =
        (w.layer === 1 ? 0.5 : 0.7) *
        (1 - w.heat * 0.25) *
        flicker *
        alphaMul *
        (0.75 + this.boost * 0.35);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${Math.min(1, alpha)})`;
      ctx.lineWidth = w.width * (1 + this.boost * 0.3) * (this.size / 220);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    _drawOverlay() {
      const ctx = this.octx;
      const S = this.size;
      ctx.clearRect(0, 0, S, S);

      ctx.save();
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
      ctx.clip();

      const back = this.wisps.filter((w) => w.layer === 1);
      const front = this.wisps.filter((w) => w.layer === 0);
      const photon = this.wisps.filter((w) => w.layer === 2);
      front.sort((a, b) => Math.sin(a.angle) - Math.sin(b.angle));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const w of back) this._drawWisp(w, 0.85);
      for (const w of front) {
        if (Math.sin(w.angle) < 0.15) this._drawWisp(w, 0.65);
      }
      ctx.restore();

      // Horizon disc (ensures solid black core above warped feed)
      const hr = this.horizon + this.pulse * 3;
      ctx.beginPath();
      ctx.fillStyle = '#000';
      ctx.arc(S / 2, S / 2, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,230,180,${0.5 + this.boost * 0.3})`;
      ctx.lineWidth = 1.6 + this.boost * 0.8;
      ctx.arc(S / 2, S / 2, hr + 0.8, 0, Math.PI * 2);
      ctx.stroke();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const w of front) {
        if (Math.sin(w.angle) >= 0.15) this._drawWisp(w, 1);
      }
      for (const w of photon) this._drawWisp(w, 1.05);
      ctx.restore();

      for (const s of this.swallows) {
        if (performance.now() < s.born) continue;
        const x = S / 2 + Math.cos(s.angle) * s.r;
        const y = S / 2 + Math.sin(s.angle) * s.r * 0.55;
        const scale = Math.max(0.15, s.r / s.startR);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(s.angle);
        ctx.scale(scale, scale);
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
