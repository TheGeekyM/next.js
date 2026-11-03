/* eslint-env jest */
import { readFile } from 'fs-extra'
import { join } from 'path'
import {
  getSharp,
  imageOptimizerTransform,
  type ImageOptimizerTransformConfig,
} from 'next/image-optimizer-transform'
import type {
  CachedRouteKind,
  IncrementalResponseCacheEntry,
} from 'next/dist/server/response-cache/types'

const getImage = (filename: string) =>
  readFile(join(__dirname, 'images', filename))

const config = {
  images: {
    dangerouslyAllowSVG: true,
    minimumCacheTTL: 60,
  },
  experimental: {
    imgOptConcurrency: 1,
    imgOptOperationCache: false,
    imgOptMaxInputPixels: 67_108_864,
    imgOptSequentialRead: true,
    imgOptTimeoutInSeconds: 6,
  },
}

async function transform(
  filename: string,
  mimeType = 'image/webp',
  nextConfig: ImageOptimizerTransformConfig = config
) {
  const buffer = await getImage(filename)
  return imageOptimizerTransform(
    {
      buffer,
      contentType: undefined,
      cacheControl: 'public, max-age=120',
      etag: 'source-etag',
    },
    { href: `/${filename}`, width: 64, quality: 75, mimeType },
    nextConfig
  )
}

async function transformInDevelopment(
  filename: string,
  previousCacheEntry?: IncrementalResponseCacheEntry
) {
  const { imageOptimizer } =
    require('next/dist/server/image-optimizer') as typeof import('next/dist/server/image-optimizer')
  const buffer = await getImage(filename)
  return imageOptimizer(
    {
      buffer,
      contentType: undefined,
      cacheControl: undefined,
      etag: 'source-etag',
    },
    { href: `/${filename}`, width: 8, quality: 70, mimeType: 'image/webp' },
    config,
    { isDev: true, silent: true, previousCacheEntry }
  )
}

describe('imageOptimizerTransform', () => {
  it('loads without the server image optimizer dependency graph', () => {
    const loaded = Object.keys(require.cache)
    expect(
      loaded.some((path) => /\/server\/image-optimizer\.[jt]s$/.test(path))
    ).toBe(false)
    expect(
      loaded.some((path) => path.includes('/server/response-cache/'))
    ).toBe(false)
    expect(
      loaded.some((path) => /\/server\/serve-static\.[jt]s$/.test(path))
    ).toBe(false)
    expect(
      loaded.some((path) => /\/server\/lib\/mock-request\.[jt]s$/.test(path))
    ).toBe(false)
    expect(
      loaded.some((path) => /\/server\/config-shared\.[jt]s$/.test(path))
    ).toBe(false)
    expect(
      loaded.some((path) => /\/build\/output\/log\.[jt]s$/.test(path))
    ).toBe(false)
  })

  it('transforms a png buffer', async () => {
    const result = await transform('test.png')
    expect(result.contentType).toBe('image/webp')
    expect(result.buffer.byteLength).toBeGreaterThan(0)
    expect(result.maxAge).toBe(120)
  })

  it.each([undefined, true, false])(
    'encodes JPEGs with imgOptMozjpeg=%s',
    async (imgOptMozjpeg) => {
      const result = await transform('test.jpg', 'image/jpeg', {
        ...config,
        experimental: { ...config.experimental, imgOptMozjpeg },
      })
      expect(result.error).toBeUndefined()
      expect(result.contentType).toBe('image/jpeg')
      const sharp = getSharp(1, false)
      expect(await sharp(result.buffer).metadata()).toMatchObject({
        format: 'jpeg',
        width: 64,
        isProgressive: imgOptMozjpeg ?? true,
      })
    }
  )

  describe('with imgOptSafeImageOptimization', () => {
    const safeConfig = {
      ...config,
      experimental: {
        ...config.experimental,
        imgOptSafeImageOptimization: true,
      },
    }

    it.each([undefined, true, false])(
      'encodes JPEGs with imgOptMozjpeg=%s',
      async (imgOptMozjpeg) => {
        const result = await transform('test.jpg', 'image/jpeg', {
          ...safeConfig,
          experimental: { ...safeConfig.experimental, imgOptMozjpeg },
        })
        expect(result.error).toBeUndefined()
        expect(result.contentType).toBe('image/jpeg')
        const sharp = getSharp(1, false)
        expect(await sharp(result.buffer).metadata()).toMatchObject({
          format: 'jpeg',
          width: 64,
        })
        // sharp's `isProgressive` is true for any JPEG with multiple scans,
        // which includes nsio's baseline output, so look for the progressive
        // (SOF2) marker instead.
        expect(result.buffer.includes(Buffer.from([0xff, 0xc2]))).toBe(
          imgOptMozjpeg ?? true
        )
      }
    )

    // `imageOptimizerTransform()` passes SVGs through, so this calls
    // `nsioOptimizeImage()` directly.
    it.each([true, false])(
      'decodes svg input with dangerouslyAllowSVG=%s',
      async (dangerouslyAllowSVG) => {
        const { nsioOptimizeImage } =
          require('next/dist/server/image-optimizer/nsio') as typeof import('next/dist/server/image-optimizer/nsio')
        const optimized = nsioOptimizeImage({
          buffer: await getImage('test.svg'),
          contentType: 'image/png',
          quality: 75,
          width: 64,
          dangerouslyAllowSVG,
        })
        if (dangerouslyAllowSVG) {
          const sharp = getSharp(1, false)
          expect(await sharp(await optimized).metadata()).toMatchObject({
            format: 'png',
            width: 64,
          })
        } else {
          await expect(optimized).rejects.toMatchObject({
            code: 'ERR_UNSUPPORTED_FORMAT',
          })
        }
      }
    )

    it.each([
      ['test.png', 'image/webp', 'webp'],
      ['test.jpg', 'image/jpeg', 'jpeg'],
      ['test.avif', 'image/png', 'png'],
      ['test.gif', '', 'gif'],
    ])('transforms %s with mimeType %p', async (filename, mimeType, format) => {
      const result = await transform(filename, mimeType, safeConfig)
      expect(result.error).toBeUndefined()
      expect(result.contentType).toBe(`image/${format}`)
      const sharp = getSharp(1, false)
      expect(await sharp(result.buffer).metadata()).toMatchObject({
        format,
        width: 64,
      })
    })

    it('falls back to the upstream image for avif output', async () => {
      const source = await getImage('test.png')
      const result = await transform('test.png', 'image/avif', safeConfig)
      expect(result.error).toBeDefined()
      expect(result.buffer).toEqual(source)
      expect(result.contentType).toBe('image/png')
    })

    // nsio doesn't support avif output, so this tells nsio and sharp apart.
    it.each([
      [{}, true],
      [{ imageResponse: true }, true],
      [{ image: true }, true],
      [{ image: false }, false],
      [{ image: false, imageResponse: true }, false],
    ])(
      'with imgOptSafeImageOptimization=%p, uses nsio: %p',
      async (imgOptSafeImageOptimization, usesNsio) => {
        const result = await transform('test.png', 'image/avif', {
          ...config,
          experimental: { ...config.experimental, imgOptSafeImageOptimization },
        })
        if (usesNsio) {
          expect(result.error).toBeDefined()
          expect(result.contentType).toBe('image/png')
        } else {
          expect(result.error).toBeUndefined()
          expect(result.contentType).toBe('image/avif')
        }
      }
    )
  })

  it('preserves the source format when no output format is requested', async () => {
    const result = await transform('test.png', '')
    expect(result.contentType).toBe('image/png')
  })

  it('transforms an avif source', async () => {
    const source = await getImage('test.avif')
    const result = await transform('test.avif')
    expect(result.buffer).not.toEqual(source)
    expect(result.contentType).toBe('image/webp')
  })

  it('downlevels an avif source when no output format is requested', async () => {
    const result = await transform('test.avif', '')
    expect(result.contentType).toBe('image/jpeg')
  })

  it('generates blur placeholders in development', async () => {
    const result = await transformInDevelopment('test.png')
    expect(result.contentType).toBe('image/svg+xml')
    expect(result.buffer.toString()).toContain('<svg')
  })

  it('does not generate blur placeholders for bypassed images', async () => {
    const source = await getImage('test.svg')
    const result = await transformInDevelopment('test.svg')
    expect(result.buffer).toEqual(source)
    expect(result.contentType).toBe('image/svg+xml')
  })

  it('reuses a previous cache entry without generating a blur placeholder', async () => {
    const previousBuffer = Buffer.from('previous image')
    const result = await transformInDevelopment('test.png', {
      value: {
        kind: 'IMAGE' as CachedRouteKind.IMAGE,
        buffer: previousBuffer,
        etag: 'optimized-etag',
        upstreamEtag: 'source-etag',
        extension: 'webp',
      },
      cacheControl: { revalidate: 90, expire: undefined },
    })
    expect(result.buffer).toEqual(previousBuffer)
    expect(result.contentType).toBe('image/webp')
    expect(result.maxAge).toBe(90)
  })

  it('bypasses svg buffers', async () => {
    const source = await getImage('test.svg')
    const result = await transform('test.svg')
    expect(result.buffer).toEqual(source)
    expect(result.contentType).toBe('image/svg+xml')
  })

  it('bypasses animated buffers', async () => {
    const source = await getImage('animated.webp')
    const result = await transform('animated.webp')
    expect(result.buffer).toEqual(source)
    expect(result.contentType).toBe('image/webp')
  })

  it('rejects disallowed svg buffers', async () => {
    await expect(
      imageOptimizerTransform(
        {
          buffer: await getImage('test.svg'),
          contentType: undefined,
          cacheControl: undefined,
          etag: 'source-etag',
        },
        { href: '/test.svg', width: 64, quality: 75, mimeType: 'image/webp' },
        {
          ...config,
          images: { ...config.images, dangerouslyAllowSVG: false },
        }
      )
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects unrecognized buffers', async () => {
    await expect(
      imageOptimizerTransform(
        {
          buffer: Buffer.from('not an image'),
          contentType: undefined,
          cacheControl: undefined,
          etag: 'source-etag',
        },
        { href: '/bad', width: 64, quality: 75, mimeType: 'image/webp' },
        config
      )
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
