const measurementId = 'G-P2XYT72XL6';

declare global {
  interface Window {
    dataLayer: IArguments[];
    gtag: (...args: unknown[]) => void;
  }
}

/**
 * Only report from the canonical production host, so `bun run dev` and
 * `bun run preview` cannot write localhost traffic into the real property.
 *
 * The host is read from the canonical link rather than hardcoded, because
 * that link is emitted from `site` in astro.config.ts -- a future domain
 * change follows automatically instead of silently killing analytics against
 * a stale constant. `?ga-debug` opts a non-production host back in so
 * `preview:analytics` can verify the tag without weakening the default guard.
 */
function shouldReport(): boolean {
  if (new URLSearchParams(location.search).has('ga-debug')) return true;
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) return false;
  return new URL(canonical.href).hostname === location.hostname;
}

/**
 * Keep reports useful without putting checkout credentials or arbitrary query
 * values into Analytics. The path is enough to distinguish every page on this
 * site.
 */
function safePageLocation(): string {
  const page = new URL(location.href);
  page.search = '';
  page.hash = '';
  return page.href;
}

function contentGroup(pathname: string): string {
  if (pathname === '/store/' || pathname === '/purchase/') return 'Store';
  if (pathname.startsWith('/photography/') || pathname === '/') return 'Photography';
  if (pathname === '/about/') return 'About';
  if (pathname === '/license/') return 'License';
  return 'Other';
}

function photoItem(link: HTMLAnchorElement) {
  const album = link.closest<HTMLElement>('[data-story-id]');
  const context = location.pathname === '/store/' ? 'Store' : 'Gallery';
  const photoId = link.dataset.photoId!;
  return {
    item_id: photoId,
    item_name: (link.dataset.alt?.trim() || photoId).slice(0, 100),
    item_category: album?.dataset.storyId ?? 'unknown',
    item_list_id: context.toLowerCase(),
    item_list_name: context,
  };
}

/** Report a photo only after it remains substantially visible, not on load. */
function observePhotos(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-lightbox][data-photo-id]')];
  if (!links.length || !('IntersectionObserver' in window)) return;

  const pending = new Map<Element, number>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const existing = pending.get(entry.target);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        pending.delete(entry.target);
      }
      if (!entry.isIntersecting || entry.intersectionRatio < 0.4) continue;

      const timeout = window.setTimeout(() => {
        const link = entry.target as HTMLAnchorElement;
        window.gtag('event', 'view_item', { items: [photoItem(link)] });
        pending.delete(link);
        observer.unobserve(link);
      }, 750);
      pending.set(entry.target, timeout);
    }
  }, { threshold: 0.4 });

  for (const link of links) observer.observe(link);
}

if (shouldReport()) {
  window.dataLayer = window.dataLayer || [];
  // gtag.js only reads a queued item as a command when it is a genuine
  // `arguments` object; a spread into an array is absorbed as data instead,
  // so `config` never registers and no page_view is sent.
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    // Send the page view explicitly so its URL can never contain the Stripe
    // Checkout session id from /purchase/?session_id=... (or any future query
    // value that was not intended as analytics data).
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  window.gtag('event', 'page_view', {
    page_title: document.title,
    page_location: safePageLocation(),
    content_group: contentGroup(location.pathname),
  });

  observePhotos();
  document.addEventListener('photo-open', (event) => {
    const link = (event as CustomEvent<{ link?: HTMLAnchorElement }>).detail?.link;
    if (link?.dataset.photoId) {
      window.gtag('event', 'select_item', { items: [photoItem(link)] });
    }
  });

  const googleTag = document.createElement('script');
  googleTag.async = true;
  googleTag.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.append(googleTag);
}

export {};
