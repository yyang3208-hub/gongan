const xmpHeader = Buffer.from('http://ns.adobe.com/xap/1.0/\0');

export class JpegIntegrity {
  constructor() {
    this.state = 'start'; this.size = 0; this.end = null; this.remaining = 0;
  }
  write(data) {
    const base = this.size; this.size += data.length;
    if (this.state === 'done') return;
    for (let index = 0; index < data.length; index++) {
      const byte = data[index];
      switch (this.state) {
        case 'start':
          if (byte !== 255) throw new RangeError('只接受实际 JPEG 照片');
          this.state = 'soi'; break;
        case 'soi':
          if (byte !== 216) throw new RangeError('只接受实际 JPEG 照片');
          this.state = 'prefix'; break;
        case 'prefix':
          if (byte !== 255) throw new RangeError('JPEG 段标记无效，文件可能损坏');
          this.state = 'marker'; break;
        case 'scan': {
          const marker = data.indexOf(255, index);
          if (marker === -1) return;
          index = marker; this.state = 'scan-marker'; break;
        }
        case 'scan-marker':
          if (byte === 0 || (byte >= 208 && byte <= 215)) { this.state = 'scan'; break; }
          if (byte === 255) break;
          this.marker(byte, base + index + 1); break;
        case 'marker':
          if (byte === 255) break;
          this.marker(byte, base + index + 1); break;
        case 'length-high':
          this.length = byte << 8; this.state = 'length-low'; break;
        case 'length-low':
          this.length += byte;
          if (this.length < 2) throw new RangeError('JPEG 段长度无效');
          this.remaining = this.length - 2; this.state = this.remaining ? 'payload' : this.afterSegment; break;
        case 'payload': {
          const count = Math.min(this.remaining, data.length - index);
          this.remaining -= count; index += count - 1;
          if (!this.remaining) this.state = this.afterSegment;
          break;
        }
      }
      if (this.state === 'done') return;
    }
  }
  marker(byte, position) {
    if (byte === 217) { this.end = position; this.state = 'done'; return; }
    if (byte === 1) { this.state = 'prefix'; return; }
    if (byte === 0 || byte === 216 || (byte >= 208 && byte <= 215)) throw new RangeError('JPEG 段标记无效');
    this.afterSegment = byte === 218 ? 'scan' : 'prefix';
    this.state = 'length-high';
  }
  finish() {
    if (this.state !== 'done') throw new RangeError('JPEG 照片缺少有效结束标记，可能上传不完整');
    const jpegTrailingBytes = this.size - this.end;
    return { jpegTrailingBytes, ...(jpegTrailingBytes > 65536 ? { jpegWarning: '有效 JPEG 图像结束后仍有较大尾部数据，原文件完整保留；请核对源文件，拼图引擎只解码有效图像' } : {}) };
  }
}

export function photoAttitude(jpeg) {
  const values = [];
  let offset = 2, invalid = false;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 255) {
    const marker = jpeg[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = jpeg.readUInt16BE(offset + 2), end = offset + length + 2;
    if (length < 2 || end > jpeg.length) break;
    const segment = jpeg.subarray(offset + 4, end);
    if (marker === 0xe1 && segment.subarray(0, xmpHeader.length).equals(xmpHeader)) {
      const xml = segment.subarray(xmpHeader.length).toString('utf8');
      const attributes = xml.matchAll(/\bdrone-dji:GimbalPitchDegree\s*=\s*(["'])(.*?)\1/gs);
      const elements = xml.matchAll(/<drone-dji:GimbalPitchDegree\b[^>]*>(.*?)<\/drone-dji:GimbalPitchDegree\s*>/gs);
      for (const raw of [...attributes].map(match => match[2]).concat([...elements].map(match => match[1]))) {
        const text = raw.trim();
        if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Math.abs(Number(text)) > 180) invalid = true;
        else values.push(Number(text));
      }
    }
    offset = end;
  }
  if (invalid || values.some(value => Math.abs(value - values[0]) > .001))
    return { viewClass: 'unknown', gimbalPitch: null, attitudeSource: null, attitudeReason: 'DJI 云台俯仰角无效或存在冲突，未自动选入正射处理' };
  if (!values.length)
    return { viewClass: 'unknown', gimbalPitch: null, attitudeSource: null, attitudeReason: '未读取到 DJI XMP GimbalPitchDegree；不按文件名或机身俯仰角推断下视镜头' };
  const gimbalPitch = values[0], nadir = Math.abs(gimbalPitch + 90) <= 2 + 1e-8;
  return { viewClass: nadir ? 'nadir' : 'oblique', gimbalPitch, attitudeSource: 'DJI XMP GimbalPitchDegree',
    attitudeReason: nadir ? '云台俯仰角位于 −90°±2°，选入快速 DOM' : '云台俯仰角不在 −90°±2°，排除倾斜照片' };
}

export function photoSelection(photos) {
  const raw = photos.filter(photo => photo.type === 'photos');
  const selected = raw.filter(photo => photo.viewClass === 'nadir' && Number.isFinite(photo.gimbalPitch) && Math.abs(photo.gimbalPitch + 90) <= 2 + 1e-8);
  const oblique = raw.filter(photo => photo.viewClass === 'oblique').length;
  return { photoIds: selected.map(photo => photo.id), summary: { total: raw.length, selected: selected.length, oblique, unknown: raw.length - selected.length - oblique, rule: 'DJI GimbalPitchDegree = −90°±2°' } };
}
