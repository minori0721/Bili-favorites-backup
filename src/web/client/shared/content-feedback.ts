export function renderContentNotice(host: HTMLElement, message = '', state: 'loading' | 'error' = 'loading', retry?: () => void) {
  host.replaceChildren();
  host.hidden = !message;
  host.dataset.state = state;
  if (!message) return;
  const text = host.ownerDocument.createElement('span');
  text.textContent = message;
  host.appendChild(text);
  if (retry) {
    const button = host.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'retry-button';
    button.textContent = '重试';
    button.addEventListener('click', retry);
    host.appendChild(button);
  }
}

export function showContentSkeleton(grid: HTMLElement) {
  const fragment = grid.ownerDocument.createDocumentFragment();
  for (let index = 0; index < 4; index++) {
    const card = grid.ownerDocument.createElement('div');
    card.className = 'content-skeleton-card';
    card.setAttribute('aria-hidden', 'true');
    const cover = grid.ownerDocument.createElement('div');
    cover.className = 'content-skeleton-cover';
    const title = grid.ownerDocument.createElement('div');
    title.className = 'content-skeleton-title';
    card.append(cover, title);
    fragment.appendChild(card);
  }
  grid.replaceChildren(fragment);
}
