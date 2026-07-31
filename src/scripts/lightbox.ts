/**
 * Behavior for components/Lightbox.astro. Drives every `a[data-lightbox]` on
 * the page (StoryPhoto.astro writes those), and keeps the URL in sync as
 * a stable fragment supplied by the page (falling back to `#photo-N`) so a
 * single photograph can be linked and the browser Back gesture closes the
 * viewer instead of leaving the story.
 */
const dialog = document.getElementById('lightbox') as HTMLDialogElement | null;
const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-lightbox]')];

if (dialog && links.length > 0) start(dialog, links);

function start(dialog: HTMLDialogElement, links: HTMLAnchorElement[]) {
  const single = dialog.dataset.single === 'true';
  const figure = dialog.querySelector('.lightbox-figure') as HTMLElement;
  const img = dialog.querySelector('img') as HTMLImageElement;
  const caption = document.getElementById('lightbox-caption') as HTMLElement;
  const closeButton = document.getElementById('lightbox-close') as HTMLButtonElement;
  const prevButton = document.getElementById('lightbox-prev') as HTMLButtonElement | null;
  const nextButton = document.getElementById('lightbox-next') as HTMLButtonElement | null;
  let current = 0;
  let activeLink: HTMLAnchorElement | undefined;
  let touchStartX: number | undefined;
  let pushedHistory = false;

  function fragmentFor(index: number): string {
    return links[index]!.dataset.photoId ?? `photo-${index + 1}`;
  }

  /**
   * The width the photo will actually occupy, which the aspect ratio can make
   * far narrower than the viewport — a landscape frame on a phone held upright
   * is limited by width, the same frame held sideways by height. Feeding that
   * to `sizes` is what stops every device fetching the widest encode.
   * Only measurable once the dialog is open; falls back to the viewport.
   */
  function sizesFor(link: HTMLAnchorElement): string {
    const style = getComputedStyle(figure);
    const available = figure.clientWidth
      - parseFloat(style.paddingLeft)
      - parseFloat(style.paddingRight);
    const height = figure.clientHeight
      - parseFloat(style.paddingTop)
      - parseFloat(style.paddingBottom)
      - caption.offsetHeight;
    if (available <= 0 || height <= 0) return '100vw';
    const aspect = Number(link.dataset.aspect) || 1.5;
    return `${Math.ceil(Math.min(available, height * aspect))}px`;
  }

  function show(index: number) {
    current = (index + links.length) % links.length;
    const link = links[current]!;
    const captionText = link.dataset.caption?.trim() ?? '';

    img.alt = link.dataset.alt ?? '';
    caption.textContent = captionText;
    caption.hidden = captionText.length === 0;

    // sizes before srcset, so the browser resolves a candidate only once.
    img.sizes = sizesFor(link);
    img.srcset = link.dataset.srcset ?? '';
    img.src = link.href;

    if (pushedHistory) history.replaceState(null, '', `#${fragmentFor(current)}`);

    if (!single) {
      for (const offset of [1, -1]) {
        const neighbor = links[(current + offset + links.length) % links.length]!;
        const preload = new Image();
        preload.sizes = sizesFor(neighbor);
        preload.srcset = neighbor.dataset.srcset ?? '';
        preload.src = neighbor.href;
      }
    }
  }

  function openAt(index: number) {
    activeLink = links[index];
    history.pushState(null, '', `#${fragmentFor(index)}`);
    pushedHistory = true;
    dialog.showModal();
    show(index);
    closeButton.focus();
  }

  links.forEach((link, index) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openAt(index);
    });
  });

  prevButton?.addEventListener('click', () => show(current - 1));
  nextButton?.addEventListener('click', () => show(current + 1));
  closeButton.addEventListener('click', () => dialog.close());

  dialog.addEventListener('keydown', (event) => {
    if (!single && event.key === 'ArrowLeft') show(current - 1);
    if (!single && event.key === 'ArrowRight') show(current + 1);
  });

  // The figure fills the dialog, so it — not the dialog — is the backdrop the
  // pointer actually lands on outside the photo.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target === figure) dialog.close();
  });

  img.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') touchStartX = event.clientX;
  });

  img.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch' || touchStartX === undefined) return;
    const distance = event.clientX - touchStartX;
    touchStartX = undefined;
    if (single || Math.abs(distance) < 50 || links.length < 2) return;
    show(distance > 0 ? current - 1 : current + 1);
  });

  // Rotating the phone changes which dimension constrains the photo.
  window.addEventListener('resize', () => {
    if (dialog.open) img.sizes = sizesFor(links[current]!);
  });

  dialog.addEventListener('close', () => {
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    img.alt = '';
    caption.textContent = '';
    caption.hidden = true;
    if (pushedHistory) {
      pushedHistory = false;
      history.back();
    }
    activeLink?.focus();
  });

  window.addEventListener('popstate', () => {
    pushedHistory = false;
    if (dialog.open) dialog.close();
  });

  const fragment = location.hash.slice(1);
  const index = links.findIndex((_, candidate) => fragmentFor(candidate) === fragment);
  if (index >= 0) {
    // Drop the hash first, so closing the viewer lands on a clean page URL.
    history.replaceState(null, '', location.pathname + location.search);
    openAt(index);
  }
}
