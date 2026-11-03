const paths = {
  overview: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  control: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  uav: '<path d="m8 8 8 8m0-8-8 8M9 10h6v4H9z"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>',
  police: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  apps: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><path d="M17 14v7m-3-3h7"/>',
  archives: '<path d="M3 6h18v4H3zM5 10v11h14V10M9 14h6M5 3h14"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  data: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12M3 15h18"/>',
  task: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 2h6v4H9zM9 11h6M9 16h6"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  points: '<path d="M12 22s7-7 7-13a7 7 0 0 0-14 0c0 6 7 13 7 13Z"/><circle cx="12" cy="9" r="2.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6h14M5 18h14"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  minus: '<path d="M4 12h16"/>',
  fullscreen: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  label: '<path d="M4 6h16M12 6v15M8 21h8"/>',
  rectangle: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="7" y="7" width="10" height="10" stroke-dasharray="2 2"/>',
  polygon: '<path d="m4 6 13-3 4 13-12 5L4 6Z"/><circle cx="4" cy="6" r="2"/><circle cx="17" cy="3" r="2"/><circle cx="21" cy="16" r="2"/><circle cx="9" cy="21" r="2"/>',
};

export function navigationIcon(key) {
  return `<svg class="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[key] || paths.overview}</svg>`;
}

export function enhanceInterface(scope = document) {
  const main = scope.querySelector('#content');
  if (main) {
    main.tabIndex = -1;
    main.setAttribute('aria-label', '当前页面内容');
  }
  const login = scope.querySelector('.login-content');
  if (login) login.tabIndex = -1;
  for (const button of scope.querySelectorAll('nav [data-nav]')) {
    if (button.classList.contains('active')) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const groupIcons = { 概览: 'overview', 视频资源: 'video', 预警布控: 'control', 智能应用: 'apps', 离线与任务: 'task', 大屏配置: 'settings', 警务执勤: 'police', 三维模型: 'data', 无人机管理: 'uav', 'AI 识别': 'search', 系统管理: 'users', 对接: 'settings' };
  for (const nav of scope.querySelectorAll('.admin-sidebar nav')) {
    let group = '';
    for (const item of nav.children) {
      if (item.classList.contains('nav-group')) group = item.textContent;
      if (item.matches('button') && !item.querySelector('svg')) item.insertAdjacentHTML('afterbegin', navigationIcon(groupIcons[group] || 'data'));
    }
  }
  for (const group of scope.querySelectorAll('.alert-tabs, .module-nav, .uav-navigation')) {
    for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  }
  for (const heading of scope.querySelectorAll('.panel-title > b, .ov-panel-heading > b')) {
    heading.setAttribute('role', 'heading');
    heading.setAttribute('aria-level', '2');
  }
  for (const wrap of scope.querySelectorAll('.table-wrap')) {
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', '数据表格，可横向滚动查看全部列');
    for (const cell of wrap.querySelectorAll('th')) cell.setAttribute('scope', 'col');
  }
  for (const error of scope.querySelectorAll('.form-error')) error.tabIndex = -1;
}

export function focusFormError(errorNode) {
  if (errorNode?.isConnected) {
    errorNode.tabIndex = -1;
    errorNode.focus();
  }
}

export function updateNativeValidation(form) {
  const errorNode = form?.querySelector('.form-error');
  if (!errorNode) return;
  if (!errorNode.id) errorNode.id = `${form.id}-error`;
  const messages = [];
  for (const input of Array.from(form.elements).filter(element => element.willValidate)) {
    const descriptions = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== errorNode.id);
    if (!input.validity.valid) {
      input.setAttribute('aria-invalid', 'true');
      descriptions.push(errorNode.id);
      const label = input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim().split('\n')[0] || '输入字段';
      messages.push(`${label}：${input.validationMessage}`);
    } else {
      input.removeAttribute('aria-invalid');
    }
    if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
    else input.removeAttribute('aria-describedby');
  }
  errorNode.textContent = messages.join('\n');
}
