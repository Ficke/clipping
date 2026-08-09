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

if (shouldReport()) {
  window.dataLayer = window.dataLayer || [];
  // gtag.js only reads a queued item as a command when it is a genuine
  // `arguments` object; a spread into an array is absorbed as data instead,
  // so `config` never registers and no page_view is sent.
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', measurementId);

  const googleTag = document.createElement('script');
  googleTag.async = true;
  googleTag.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.append(googleTag);
}

export {};
