const measurementId = 'G-P2XYT72XL6';

declare global {
  interface Window {
    dataLayer: IArguments[];
    gtag: (...args: unknown[]) => void;
  }
}

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

export {};
