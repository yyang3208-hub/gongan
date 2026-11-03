function shader(gl, type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source); gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(value);
    gl.deleteShader(value);
    throw new Error(`全景着色器初始化失败：${message}`);
  }
  return value;
}

export function mountPanoramaPair(container, assets, { onError }) {
  let destroyed = false, yaw = 0, pitch = 0, fov = 80;
  const scenes = [], listeners = [];
  const listen = (element, type, handler, options) => {
    element.addEventListener(type, handler, options); listeners.push(() => element.removeEventListener(type, handler, options));
  };
  const draw = () => {
    if (destroyed) return;
    for (const scene of scenes) {
      const { gl, canvas, program, ready, heading } = scene;
      if (!ready) continue;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio, 2)));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform4f(gl.getUniformLocation(program, 'view'), (yaw - heading) * Math.PI / 180, pitch * Math.PI / 180, Math.tan(fov * Math.PI / 360), canvas.width / canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      canvas.dataset.view = `${yaw.toFixed(1)},${pitch.toFixed(1)},${fov.toFixed(1)}`;
    }
    container.querySelector('[data-pano-readout]').textContent = `联动视角 · 方位 ${yaw.toFixed(0)}° / 俯仰 ${pitch.toFixed(0)}° / 视场 ${fov.toFixed(0)}°`;
  };
  function dispose() {
    if (destroyed) return;
    destroyed = true; observer.disconnect();
    for (const remove of listeners) remove();
    for (const { gl, program, buffer, texture, shaders, image } of scenes) {
      image.onload = null; image.onerror = null; image.src = '';
      gl.deleteTexture(texture); gl.deleteBuffer(buffer);
      gl.deleteProgram(program); for (const value of shaders) gl.deleteShader(value);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  const observer = new ResizeObserver(draw);
  try {
    for (const [index, asset] of assets.entries()) {
      const canvas = container.querySelectorAll('canvas')[index];
      if (!canvas) throw new Error('全景画布缺失');
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
      if (!gl) throw new Error('当前浏览器不支持 WebGL 全景查看');
      const shaders = [
        shader(gl, gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){ uv=p; gl_Position=vec4(p,0.,1.); }'),
        shader(gl, gl.FRAGMENT_SHADER, `precision highp float; varying vec2 uv; uniform sampler2D image; uniform vec4 view;
          void main(){
            vec3 d=normalize(vec3(uv.x*view.z*view.w,uv.y*view.z,1.));
            d=vec3(d.x,d.y*cos(view.y)+d.z*sin(view.y),-d.y*sin(view.y)+d.z*cos(view.y));
            float longitude=atan(d.x,d.z)+view.x;
            vec2 sampleUV=vec2(fract(longitude/6.28318530718+.5),.5-asin(clamp(d.y,-1.,1.))/3.14159265359);
            gl_FragColor=texture2D(image,sampleUV);
          }`),
      ];
      const program = gl.createProgram();
      for (const value of shaders) gl.attachShader(program, value);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('全景渲染程序链接失败');
      gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const image = new Image();
      const scene = { gl, canvas, program, buffer, texture, shaders, image, heading: asset.heading || 0, ready: false };
      scenes.push(scene);
      image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        if (destroyed) return;
        try {
          if (Math.abs(image.naturalWidth / image.naturalHeight - 2) > .02) throw new Error('全景必须是 2:1 等距柱状投影图，普通照片不能作为全景');
          if (image.naturalWidth > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('全景宽度超过当前显卡纹理上限，请发布较低分辨率版本');
          gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('全景纹理创建失败，请检查图片跨域和显卡支持');
          scene.ready = true; canvas.dataset.panoramaReady = 'true'; draw();
        } catch (error) { onError(`${asset.name}：${error.message}`); }
      };
      image.onerror = () => { if (!destroyed) onError(`${asset.name}：全景图片加载失败，请检查地址、访问权限和 CORS。`); };
      image.src = asset.url;
      let pointer;
      listen(canvas, 'pointerdown', event => {
        canvas.focus(); canvas.setPointerCapture(event.pointerId);
        pointer = { x: event.clientX, y: event.clientY, yaw, pitch };
      });
      listen(canvas, 'pointermove', event => {
        if (!pointer) return;
        yaw = ((pointer.yaw - (event.clientX - pointer.x) * .2) % 360 + 360) % 360;
        pitch = Math.max(-85, Math.min(85, pointer.pitch + (event.clientY - pointer.y) * .2)); draw();
      });
      listen(canvas, 'pointerup', () => { pointer = undefined; });
      listen(canvas, 'pointercancel', () => { pointer = undefined; });
      listen(canvas, 'lostpointercapture', () => { pointer = undefined; });
      listen(canvas, 'wheel', event => { event.preventDefault(); fov = Math.max(30, Math.min(110, fov + Math.sign(event.deltaY) * 5)); draw(); }, { passive: false });
      listen(canvas, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) return;
        event.preventDefault();
        yaw = (yaw + (event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0) + 360) % 360;
        pitch = Math.max(-85, Math.min(85, pitch + (event.key === 'ArrowUp' ? 5 : event.key === 'ArrowDown' ? -5 : 0)));
        fov = Math.max(30, Math.min(110, fov + (event.key === '-' ? 5 : ['+', '='].includes(event.key) ? -5 : 0))); draw();
      });
      observer.observe(canvas);
    }
    listen(container.querySelector('[data-pano-reset]'), 'click', () => { yaw = 0; pitch = 0; fov = 80; draw(); });
    draw();
    return { destroy: dispose };
  } catch (error) { dispose(); throw error; }
}
