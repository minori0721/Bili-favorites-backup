export function bilibiliVideoUrl(identifier: string): string | null {
  const id = identifier.trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(id) && !/^av[1-9][0-9]*$/.test(id)) return null;
  return `https://www.bilibili.com/video/${id}/`;
}

export function createBilibiliVideoReference(root: Document, identifier: string): HTMLElement {
  return createReference(root, identifier || '-', bilibiliVideoUrl(identifier), 'bilibili-video-link', `${identifier}，在 B站打开（新窗口）`);
}

export function bilibiliProfileUrl(uid: number | undefined): string | null {
  return uid !== undefined && Number.isSafeInteger(uid) && uid > 0 ? `https://space.bilibili.com/${uid}` : null;
}

export function createBilibiliProfileReference(root: Document, name: string, uid: number | undefined): HTMLElement {
  return createReference(root, name, bilibiliProfileUrl(uid), 'bilibili-profile-link', `${name}，在 B站打开 UP 主页（新窗口）`, false);
}

function createReference(root: Document, label: string, url: string | null, className: string, accessibleLabel: string, withArrow = true): HTMLElement {
  if (!url) {
    const text = root.createElement('span');
    text.textContent = label;
    return text;
  }
  const link = root.createElement('a');
  link.className = `bilibili-reference-link ${className}`;
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', accessibleLabel);
  link.append(root.createTextNode(label));
  if (withArrow) {
    const arrow = root.createElement('span');
    arrow.className = 'bilibili-reference-arrow';
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    link.append(arrow);
  }
  return link;
}
