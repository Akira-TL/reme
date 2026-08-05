const SOFTWARE_RENDERER_PATTERN = /(swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|angle.*warp)/i;

export function isSoftwareWebGlRenderer(renderer) {
  return typeof renderer === "string" && SOFTWARE_RENDERER_PATTERN.test(renderer);
}

export function inspectWebGlRenderer() {
  if (typeof document === "undefined") {
    return { available: false, renderer: "unknown", software: false };
  }

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { powerPreference: "high-performance" })
    || canvas.getContext("webgl", { powerPreference: "high-performance" });
  if (!gl) {
    return { available: false, renderer: "WebGL unavailable", software: false };
  }

  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = extension
    ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const normalized = typeof renderer === "string" && renderer.trim()
    ? renderer.trim()
    : "WebGL renderer unavailable";

  return {
    available: true,
    renderer: normalized,
    software: isSoftwareWebGlRenderer(normalized),
  };
}

export function assertHardwareWebGl(rendererInfo) {
  if (!rendererInfo.available) {
    throw new Error("浏览器未提供 WebGL，无法启用 GPU 姿态推理");
  }
  if (rendererInfo.software) {
    throw new Error(`浏览器正在使用软件渲染器：${rendererInfo.renderer}`);
  }
}
