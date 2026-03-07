export type WebGLBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'silhouette-alpha'
  | 'silhouette-luma'
  | undefined;

export interface WebGLComposeLayerOptions {
  opacity: number;
  blendMode: WebGLBlendMode;
  silhouetteGamma?: number;
}

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const COMPOSE_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uDst;
uniform float uOpacity;
uniform int uMode;
uniform float uSilhouetteGamma;
out vec4 outColor;

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 overlayBlend(vec3 s, vec3 d) {
  return mix(2.0 * s * d, 1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(0.5, d));
}

vec4 sourceOver(vec3 srcColor, float srcAlpha, vec4 dst) {
  vec3 srcPm = srcColor * srcAlpha;
  vec3 dstPm = dst.rgb * dst.a;
  float outA = srcAlpha + dst.a * (1.0 - srcAlpha);
  vec3 outPm = srcPm + dstPm * (1.0 - srcAlpha);
  vec3 outRgb = outA > 0.000001 ? outPm / outA : vec3(0.0);
  return vec4(outRgb, outA);
}

void main() {
  vec4 src = texture(uSrc, vUv);
  vec4 dst = texture(uDst, vUv);
  float srcAlpha = clamp(src.a * uOpacity, 0.0, 1.0);

  if (uMode == 5) {
    float keep = 1.0 - srcAlpha;
    vec3 dstPm = dst.rgb * dst.a;
    float outA = dst.a * keep;
    vec3 outPm = dstPm * keep;
    vec3 outRgb = outA > 0.000001 ? outPm / outA : vec3(0.0);
    outColor = vec4(outRgb, outA);
    return;
  }

  if (uMode == 6) {
    float gamma = max(0.01, uSilhouetteGamma);
    float matte = pow(clamp(luma(src.rgb), 0.0, 1.0), gamma) * srcAlpha;
    float keep = 1.0 - matte;
    vec3 dstPm = dst.rgb * dst.a;
    float outA = dst.a * keep;
    vec3 outPm = dstPm * keep;
    vec3 outRgb = outA > 0.000001 ? outPm / outA : vec3(0.0);
    outColor = vec4(outRgb, outA);
    return;
  }

  vec3 blended = src.rgb;
  if (uMode == 1) {
    blended = src.rgb * dst.rgb;
  } else if (uMode == 2) {
    blended = 1.0 - (1.0 - src.rgb) * (1.0 - dst.rgb);
  } else if (uMode == 3) {
    blended = overlayBlend(src.rgb, dst.rgb);
  } else if (uMode == 4) {
    blended = min(vec3(1.0), src.rgb + dst.rgb);
  }

  outColor = sourceOver(blended, srcAlpha, dst);
}
`;

const PRESENT_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;
void main() {
  outColor = texture(uTexture, vUv);
}
`;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed creating WebGL shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error('Failed creating WebGL program');
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? 'Unknown program link error';
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) {
    throw new Error('Failed creating WebGL texture');
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function allocateTexture(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  width: number,
  height: number,
): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

function createFramebuffer(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    throw new Error('Failed creating WebGL framebuffer');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    throw new Error(`Incomplete framebuffer: ${status}`);
  }
  return framebuffer;
}

function blendModeToInt(mode: WebGLBlendMode): number {
  switch (mode) {
    case 'multiply':
      return 1;
    case 'screen':
      return 2;
    case 'overlay':
      return 3;
    case 'add':
      return 4;
    case 'silhouette-alpha':
      return 5;
    case 'silhouette-luma':
      return 6;
    case 'normal':
    default:
      return 0;
  }
}

export class WebGL2LayerComposer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly composeProgram: WebGLProgram;
  private readonly presentProgram: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly sourceTexture: WebGLTexture;
  private readonly accumTextures: [WebGLTexture, WebGLTexture];
  private readonly framebuffers: [WebGLFramebuffer, WebGLFramebuffer];
  private width = 0;
  private height = 0;
  private frontIndex = 0;

  private readonly composeUniforms: {
    src: WebGLUniformLocation;
    dst: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    mode: WebGLUniformLocation;
    silhouetteGamma: WebGLUniformLocation;
  };

  private readonly presentTextureUniform: WebGLUniformLocation;

  private constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, width);
    this.canvas.height = Math.max(1, height);

    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      throw new Error('WebGL2 is not available');
    }

    this.gl = gl;
    this.composeProgram = createProgram(gl, VERTEX_SHADER_SOURCE, COMPOSE_FRAGMENT_SHADER_SOURCE);
    this.presentProgram = createProgram(gl, VERTEX_SHADER_SOURCE, PRESENT_FRAGMENT_SHADER_SOURCE);

    const quadBuffer = gl.createBuffer();
    if (!quadBuffer) {
      throw new Error('Failed creating WebGL quad buffer');
    }
    this.quadBuffer = quadBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.sourceTexture = createTexture(gl);
    const accumA = createTexture(gl);
    const accumB = createTexture(gl);
    this.accumTextures = [accumA, accumB];

    allocateTexture(gl, accumA, this.canvas.width, this.canvas.height);
    allocateTexture(gl, accumB, this.canvas.width, this.canvas.height);

    const fbA = createFramebuffer(gl, accumA);
    const fbB = createFramebuffer(gl, accumB);
    this.framebuffers = [fbA, fbB];

    const srcUniform = gl.getUniformLocation(this.composeProgram, 'uSrc');
    const dstUniform = gl.getUniformLocation(this.composeProgram, 'uDst');
    const opacityUniform = gl.getUniformLocation(this.composeProgram, 'uOpacity');
    const modeUniform = gl.getUniformLocation(this.composeProgram, 'uMode');
    const gammaUniform = gl.getUniformLocation(this.composeProgram, 'uSilhouetteGamma');
    const presentTextureUniform = gl.getUniformLocation(this.presentProgram, 'uTexture');

    if (
      !srcUniform ||
      !dstUniform ||
      !opacityUniform ||
      !modeUniform ||
      !gammaUniform ||
      !presentTextureUniform
    ) {
      throw new Error('Missing required WebGL uniforms');
    }

    this.composeUniforms = {
      src: srcUniform,
      dst: dstUniform,
      opacity: opacityUniform,
      mode: modeUniform,
      silhouetteGamma: gammaUniform,
    };
    this.presentTextureUniform = presentTextureUniform;

    this.resize(width, height);
  }

  static create(width: number, height: number): WebGL2LayerComposer | null {
    try {
      return new WebGL2LayerComposer(width, height);
    } catch {
      return null;
    }
  }

  get outputCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (nextWidth === this.width && nextHeight === this.height) {
      return;
    }

    this.width = nextWidth;
    this.height = nextHeight;
    this.canvas.width = nextWidth;
    this.canvas.height = nextHeight;

    const gl = this.gl;
    allocateTexture(gl, this.accumTextures[0], nextWidth, nextHeight);
    allocateTexture(gl, this.accumTextures[1], nextWidth, nextHeight);
    gl.viewport(0, 0, nextWidth, nextHeight);
  }

  begin(): void {
    const gl = this.gl;
    this.frontIndex = 0;

    for (const framebuffer of this.framebuffers) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  drawLayer(source: TexImageSource, options: WebGLComposeLayerOptions): void {
    const gl = this.gl;
    const backIndex = this.frontIndex === 0 ? 1 : 0;

    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[backIndex]);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.composeProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(this.composeUniforms.src, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[this.frontIndex]);
    gl.uniform1i(this.composeUniforms.dst, 1);

    gl.uniform1f(this.composeUniforms.opacity, Math.max(0, Math.min(1, options.opacity)));
    gl.uniform1i(this.composeUniforms.mode, blendModeToInt(options.blendMode));
    gl.uniform1f(
      this.composeUniforms.silhouetteGamma,
      Math.max(0.01, options.silhouetteGamma ?? 1),
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.frontIndex = backIndex;
  }

  presentTo2d(targetCtx: CanvasRenderingContext2D): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.presentProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[this.frontIndex]);
    gl.uniform1i(this.presentTextureUniform, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    targetCtx.save();
    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.globalAlpha = 1;
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.filter = 'none';
    targetCtx.drawImage(this.canvas, 0, 0);
    targetCtx.restore();
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.composeProgram);
    gl.deleteProgram(this.presentProgram);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteTexture(this.sourceTexture);
    gl.deleteTexture(this.accumTextures[0]);
    gl.deleteTexture(this.accumTextures[1]);
    gl.deleteFramebuffer(this.framebuffers[0]);
    gl.deleteFramebuffer(this.framebuffers[1]);
  }
}
