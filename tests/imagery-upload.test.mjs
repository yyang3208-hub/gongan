import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPhotoImport, validateUploadBatch } from '../shared/imagery-upload.mjs';

const limits = { maxFileBytes: 100 * 1024 ** 2, maxMissionBytes: 10 * 1024 ** 3, maxPhotos: 5000, maxGroups: 200 };
const file = (path, size = 10 * 1024 ** 2) => ({ name: path.split('/').at(-1), webkitRelativePath: path, size });

test('recursive photo import separates first-level flights, preserves nested names and accounts for every JPEG', () => {
  const input = [file('root/011/camera/nested/same.JPG'), file('root/011/other/same.jpg'),
    file('root/012/same.JPEG'), file('root/direct.jpg'), file('root/013/flight.obs'), file('root/readme.txt')];
  const plan = planPhotoImport(input, limits);
  assert.equal(plan.total, 4); assert.equal(plan.ignored, 2); assert.equal(plan.groups.length, 3);
  assert.deepEqual(plan.groups.map(group => group.label), ['011', '012', 'root']);
  assert.equal(plan.groups[0].files.length, 2);
  assert.equal(plan.groups[0].files[0].webkitRelativePath, 'root/011/camera/nested/same.JPG');
  assert.equal(plan.groups.reduce((sum, group) => sum + group.files.length, 0), plan.total);
  assert.equal(planPhotoImport([file('011/a.JPG'), file('011/b.jpg')], limits).groups.length, 1);
});

test('a 24 GB root is accepted when every flight fits 10 GB, but oversized flights fail before task creation', () => {
  const input = [];
  for (let flight = 0; flight < 4; flight++) for (let index = 0; index < 80; index++)
    input.push(file(`root/${flight}/${index}.jpg`, 80 * 1024 ** 2));
  const plan = planPhotoImport(input, limits);
  assert.ok(plan.totalBytes > 24 * 1024 ** 3); assert.equal(plan.groups.length, 4);
  assert.ok(plan.groups.every(group => group.bytes < limits.maxMissionBytes));
  assert.throws(() => planPhotoImport(input.map((item, index) => ({ ...item, webkitRelativePath: `root/one/${index}.jpg` })), limits), /one.*10 GB/);
  assert.throws(() => validateUploadBatch([file('x.jpg', limits.maxFileBytes + 1)], limits), /100 MB/);
  assert.throws(() => validateUploadBatch([file('empty.jpg', 0)], limits), /尺寸无效/);
  assert.throws(() => planPhotoImport([file('root/log.obs')], limits), /JPEG/);
  assert.throws(() => planPhotoImport([file('root/../x.jpg')], limits), /相对路径/);
  assert.throws(() => planPhotoImport([file('root/x.jpg'), file('root/x.jpg')], limits), /重复/);
  assert.throws(() => planPhotoImport([file('root/a/x.jpg'), file('root/b/x.jpg')], { ...limits, maxGroups: 1 }), /航次/);
});
