'use client';

import { useState } from 'react';
import Image from 'next/image';

/**
 * A notebook cover that degrades to the generated design instead of a broken
 * image.
 *
 * A subject can point at a cover object that is no longer there — the file was
 * removed from the bucket by hand, storage was switched between drivers, or an
 * upload half-finished. The server cannot know that without a HEAD on every
 * card, which would make the shelf slow for a problem that is rare. So the
 * fallback is decided in the browser: if the image fails to load for any
 * reason, the generated cover takes its place and the card still looks
 * deliberate.
 */
export function CoverImage({
  src,
  alt,
  sizes,
  priority = false,
  fallback,
}: {
  src: string;
  alt: string;
  sizes: string;
  priority?: boolean;
  fallback: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) return <>{fallback}</>;

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      className="object-cover transition-transform duration-200 group-hover:scale-[1.03]"
      priority={priority}
      loading={priority ? undefined : 'lazy'}
      onError={() => setFailed(true)}
    />
  );
}
