const measurementId = 'G-P2XYT72XL6';

declare global {
  interface Window {
    dataLayer: unknown[][];
    gtag: (...args: unknown[]) => void;
  }
}

window.dataLayer = window.dataLayer || [];
window.gtag = (...args: unknown[]) => {
  window.dataLayer.push(args);
};

window.gtag('js', new Date());
window.gtag('config', measurementId);

const googleTag = document.createElement('script');
googleTag.async = true;
googleTag.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
document.head.append(googleTag);

export {};
