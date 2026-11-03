export function imageDescriptor(pixels) {
  if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== 9 * 8 * 4) throw new Error('图像描述须使用 9 × 8 RGBA 像素');
  const gray = [], color = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    const rgb = [0, 1, 2].map(channel => pixels[i + channel] * alpha + 255 * (1 - alpha));
    rgb.forEach((value, channel) => { color[channel] += value / 72; });
    gray.push(rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114);
  }
  const hash = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash.push(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
  return { hash, color };
}

export function imageSimilarity(a, b) {
  const distance = a.hash.reduce((sum, value, i) => sum + (value !== b.hash[i] ? 1 : 0), 0) / 64;
  const color = a.color.reduce((sum, value, i) => sum + Math.abs(value - b.color[i]), 0) / 765;
  return Math.round((1 - distance * .6 - color * .4) * 1000) / 10;
}
