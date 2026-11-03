export function validateUploadBatch(files, limits) {
  if (!files.length) throw new RangeError('请先选择需要上传的文件');
  if (files.some(file => !Number.isFinite(file.size) || file.size <= 0 || file.size > limits.maxFileBytes))
    throw new RangeError(`所选文件中有文件超过 ${Math.floor(limits.maxFileBytes / 1024 ** 2)} MB 或尺寸无效；尚未上传`);
  if (files.length > limits.maxPhotos || files.reduce((sum, file) => sum + file.size, 0) > limits.maxMissionBytes)
    throw new RangeError(`每个航次最多 ${limits.maxPhotos} 张 / ${Math.floor(limits.maxMissionBytes / 1024 ** 3)} GB；请拆分该航次，尚未上传`);
}

export function planPhotoImport(input, limits) {
  const files = [...input].filter(file => /\.jpe?g$/i.test(file.name));
  if (!files.length) throw new RangeError('所选目录没有 JPEG 航拍照片');
  const seen = new Set(), groups = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name, parts = path.split('/');
    if (path.length > 1000 || /[\\:\x00-\x1f]/.test(path) || parts.some(part => !part || part === '.' || part === '..'))
      throw new RangeError('照片文件名须为有效相对路径，不能包含盘符或 ..');
    if (seen.has(path)) throw new RangeError(`所选文件中有重复相对路径：${path}`);
    seen.add(path);
    const root = file.webkitRelativePath ? parts[0] : '所选照片', flight = parts.length >= 3 ? parts[1] : '';
    const key = `${root}/${flight}`, group = groups.get(key) || { key, label: flight || root, rootFiles: !flight, files: [], bytes: 0 };
    group.files.push(file); group.bytes += file.size; groups.set(key, group);
  }
  if (groups.size > limits.maxGroups) throw new RangeError(`单次最多导入 ${limits.maxGroups} 个航次，请分批选择目录`);
  const ordered = [...groups.values()].sort((a, b) => Number(a.rootFiles) - Number(b.rootFiles) || a.key.localeCompare(b.key));
  for (const group of ordered) {
    try { validateUploadBatch(group.files, limits); }
    catch (error) { throw new RangeError(`航次“${group.label}”：${error.message}`); }
    group.files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
  }
  return { groups: ordered, total: files.length, totalBytes: ordered.reduce((sum, group) => sum + group.bytes, 0), ignored: input.length - files.length };
}
