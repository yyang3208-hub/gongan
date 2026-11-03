const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const wp = (name, value) => `<wpml:${name}>${value}</wpml:${name}>`;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path), bytes = Buffer.from(content), crc = crc32(bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
export function missionKmz(mission) {
  const config = wp('missionConfig', wp('flyToWaylineMode', 'safely') + wp('finishAction', 'goHome') + wp('exitOnRCLost', 'executeLostAction') + wp('executeRCLostAction', 'goBack') + wp('takeOffSecurityHeight', 20) + wp('globalTransitionalSpeed', mission.speed) + wp('droneInfo', wp('droneEnumValue', 77) + wp('droneSubEnumValue', 0)) + wp('payloadInfo', wp('payloadEnumValue', 68) + wp('payloadPositionIndex', 0)));
  const heading = point => wp('waypointHeadingParam', wp('waypointHeadingMode', 'fixed') + wp('waypointHeadingAngle', point.heading > 180 ? point.heading - 360 : point.heading) + wp('waypointPoiPoint', '0,0,0') + wp('waypointHeadingPathMode', 'followBadArc') + wp('waypointHeadingAngleEnable', 1));
  const turn = wp('waypointTurnParam', wp('waypointTurnMode', 'toPointAndStopWithDiscontinuityCurvature') + wp('waypointTurnDampingDist', 0));
  const action = (id, name, parameters) => wp('action', wp('actionId', id) + wp('actionActuatorFunc', name) + wp('actionActuatorFuncParam', parameters));
  const actions = (point, index) => wp('actionGroup',
    wp('actionGroupId', index) + wp('actionGroupStartIndex', index) + wp('actionGroupEndIndex', index) + wp('actionGroupMode', 'sequence') +
    wp('actionTrigger', wp('actionTriggerType', 'reachPoint')) +
    action(0, 'gimbalRotate', wp('payloadPositionIndex', 0) + wp('gimbalHeadingYawBase', 'north') + wp('gimbalRotateMode', 'absoluteAngle') + wp('gimbalPitchRotateEnable', 1) + wp('gimbalPitchRotateAngle', point.gimbalPitch) + wp('gimbalRollRotateEnable', 0) + wp('gimbalRollRotateAngle', 0) + wp('gimbalYawRotateEnable', 0) + wp('gimbalYawRotateAngle', 0) + wp('gimbalRotateTimeEnable', 0) + wp('gimbalRotateTime', 0)) +
    action(1, 'hover', wp('hoverTime', 1)) + action(2, 'takePhoto', wp('payloadPositionIndex', 0) + wp('fileSuffix', `shot${index}`) + wp('payloadLensIndex', 'wide') + wp('useGlobalPayloadLensIndex', 0)));
  const placemark = (point, index, execution) => `<Placemark><Point><coordinates>${point.longitude.toFixed(9)},${point.latitude.toFixed(9)}</coordinates></Point>${wp('index', index)}${
    execution ? wp('executeHeight', point.altitude) + wp('waypointSpeed', mission.speed) : wp('useGlobalHeight', 1) + wp('ellipsoidHeight', point.altitude) + wp('height', point.altitude) + wp('useGlobalSpeed', 1) + wp('useGlobalHeadingParam', 0) + wp('useGlobalTurnParam', 0) + wp('gimbalPitchAngle', point.gimbalPitch)
  }${heading(point)}${turn}${wp('useStraightLine', 1)}${actions(point, index)}</Placemark>`;
  const common = wp('templateId', 0) + wp('autoFlightSpeed', mission.speed);
  const payload = wp('payloadParam', wp('payloadPositionIndex', 0) + wp('imageFormat', 'wide'));
  const template = `<Folder>${wp('templateType', 'waypoint')}${common}${wp('waylineCoordinateSysParam', wp('coordinateMode', 'WGS84') + wp('heightMode', 'relativeToStartPoint') + wp('positioningType', 'GPS'))}${wp('globalHeight', mission.altitude)}${wp('gimbalPitchMode', 'usePointSetting')}${heading(mission.plan.waypoints[0]).replaceAll('waypointHeadingParam>', 'globalWaypointHeadingParam>')}${wp('globalWaypointTurnMode', 'toPointAndStopWithDiscontinuityCurvature')}${wp('globalUseStraightLine', 1)}${mission.plan.waypoints.map((p, i) => placemark(p, i, false)).join('')}${payload}</Folder>`;
  const waylines = `<Folder>${common}${wp('executeHeightMode', 'relativeToStartPoint')}${wp('waylineId', 0)}${wp('distance', mission.plan.distanceM.toFixed(3))}${wp('duration', mission.plan.durationSeconds)}${mission.plan.waypoints.map((p, i) => placemark(p, i, true)).join('')}${payload}</Folder>`;
  const document = folder => `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2"><Document><name>${xml(mission.name)}</name>${wp('author', 'Local Imagery Platform')}${wp('createTime', Date.parse(mission.createdAt || new Date().toISOString()))}${wp('updateTime', Date.now())}${config}${folder}</Document></kml>`;
  return zip([['wpmz/template.kml', document(template)], ['wpmz/waylines.wpml', document(waylines)]]);
}
