export const photoProfile = {
  version: 'photo-v1',
  responsiveWidths: [640, 1080, 1600, 2000],
  formats: {
    avif: { quality: 60 },
    webp: { quality: 80 },
    jpeg: { quality: 85, mozjpeg: true },
  },
  lightbox: { width: 2000, format: 'webp', quality: 90 },
  social: { width: 1200, format: 'jpeg', quality: 85, mozjpeg: true },
};

export function derivativeDefinitions(sourceWidth) {
  const definitions = [];

  for (const requestedWidth of photoProfile.responsiveWidths) {
    const width = Math.min(requestedWidth, sourceWidth);
    for (const [format, options] of Object.entries(photoProfile.formats)) {
      definitions.push({
        role: 'responsive',
        format,
        width,
        quality: options.quality,
        mozjpeg: options.mozjpeg ?? false,
      });
    }
  }

  definitions.push({
    role: 'lightbox',
    format: photoProfile.lightbox.format,
    width: Math.min(photoProfile.lightbox.width, sourceWidth),
    quality: photoProfile.lightbox.quality,
    mozjpeg: false,
  });
  definitions.push({
    role: 'social',
    format: photoProfile.social.format,
    width: Math.min(photoProfile.social.width, sourceWidth),
    quality: photoProfile.social.quality,
    mozjpeg: photoProfile.social.mozjpeg,
  });

  const unique = new Map();
  for (const definition of definitions) {
    unique.set(variantName(definition), definition);
  }
  return [...unique.values()];
}

export function variantName(definition) {
  const extension = definition.format === 'jpeg' ? 'jpg' : definition.format;
  return `${definition.role}-${definition.width}-q${definition.quality}.${extension}`;
}

export function derivativeKey(sourceHash, definition) {
  return `media/${photoProfile.version}/${sourceHash.slice(0, 2)}/${sourceHash}/${variantName(definition)}`;
}

export function derivativeUrl(sourceHash, definition) {
  return `/${derivativeKey(sourceHash, definition)}`;
}

export function scaledHeight(sourceWidth, sourceHeight, targetWidth) {
  return Math.max(1, Math.round((sourceHeight * targetWidth) / sourceWidth));
}
