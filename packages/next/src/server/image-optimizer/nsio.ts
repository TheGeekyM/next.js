// nsio (`@next/safe-image-optimization`) is an alternative to sharp, enabled by
// `experimental.imgOptSafeImageOptimization`.
//
// This module is imported by `transform.ts`, which runs in a child process, so
// keep its imports minimal. nsio itself is only required when it's used.
import type { InputFormat, Pool } from '@next/safe-image-optimization'
import type { NextConfigComplete } from '../config-shared'
import { GIF, JPEG, PNG, WEBP } from './image-type'

/** The content types that nsio can encode. */
export const NSIO_OUTPUT_TYPES: readonly string[] = [GIF, JPEG, PNG, WEBP]

// The defaults for features that are omitted from an
// `imgOptSafeImageOptimization` object.
const FEATURE_DEFAULTS = {
  image: true,
  imageResponse: false,
}

let _pool: Pool | undefined

export function isNsioEnabled(
  config: NextConfigComplete['experimental']['imgOptSafeImageOptimization'],
  feature: keyof typeof FEATURE_DEFAULTS
): boolean {
  if (typeof config === 'object') {
    return config[feature] ?? FEATURE_DEFAULTS[feature]
  }
  return config ?? false
}

function getPool(concurrency: number | null | undefined): Pool {
  if (!_pool) {
    const { Pool } =
      require('@next/safe-image-optimization') as typeof import('@next/safe-image-optimization')
    _pool = new Pool({ concurrency: concurrency ?? undefined })
  }
  return _pool
}

/**
 * The nsio equivalent of `optimizeImage()`.
 *
 * Unlike sharp, nsio has no operation cache, so every request decodes and
 * encodes the image again.
 * TODO: implement an operation cache.
 */
export async function nsioOptimizeImage({
  buffer,
  contentType,
  quality,
  width,
  concurrency,
  limitInputPixels,
  timeoutInSeconds,
  mozjpeg = true,
  dangerouslyAllowSVG = false,
}: {
  buffer: Buffer
  contentType: string
  quality: number
  width: number
  concurrency?: number | null
  limitInputPixels?: number
  timeoutInSeconds?: number
  mozjpeg?: boolean
  dangerouslyAllowSVG?: boolean
}): Promise<Buffer> {
  if (!NSIO_OUTPUT_TYPES.includes(contentType)) {
    // `toBuffer()` would otherwise keep the input format, which may not match
    // `contentType`. The caller falls back to the upstream image.
    throw new Error(
      `Unsupported output content type for nsio image optimization: ${contentType}`
    )
  }

  // The same formats that `getSharp()` allows. Unlike sharp, nsio only decodes
  // SVGs when they're explicitly allowed.
  const inputFormats: InputFormat[] = [
    'avif',
    'gif',
    'jpeg',
    'png',
    'tiff',
    'webp',
  ]
  if (dangerouslyAllowSVG) {
    inputFormats.push('svg')
  }

  const pipeline = getPool(concurrency)
    .prepare(buffer)
    .allowInputFormats(inputFormats)
    .timeoutMs((timeoutInSeconds ?? 7) * 1000)
    .autoOrient()
    .resize(width, null, { withoutEnlargement: true })

  if (limitInputPixels !== undefined) {
    pipeline.limitInputPixels(limitInputPixels)
  }

  if (contentType === WEBP) {
    pipeline.webp({ quality })
  } else if (contentType === PNG) {
    // Unlike sharp, there's no palette quantization, so `quality` doesn't
    // apply to PNGs.
    pipeline.png()
  } else if (contentType === JPEG) {
    // Like sharp, mozjpeg output is progressive, and baseline otherwise.
    pipeline.jpeg({ quality, mozjpeg })
  } else {
    pipeline.gif()
  }

  return pipeline.toBuffer()
}
