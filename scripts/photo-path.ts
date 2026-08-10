import path from 'node:path';
import { photoFilenameSchema } from '../shared/media';

/** Resolve a validated photo basename and enforce the destination boundary. */
export function resolvePhotoDestination(directory: string, file: string): string {
  const parsed = photoFilenameSchema.safeParse(file);
  if (!parsed.success) {
    throw new Error(`Unsafe photo filename ${JSON.stringify(file)}: ${parsed.error.issues[0]?.message}`);
  }

  const root = path.resolve(directory);
  const destination = path.resolve(root, parsed.data);
  if (path.dirname(destination) !== root) {
    throw new Error(`Photo destination escapes ${root}: ${JSON.stringify(file)}`);
  }
  return destination;
}
