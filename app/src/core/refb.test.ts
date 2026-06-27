import { describe, expect, it } from 'vitest'
import { looksLikeImageBytes, sniffImageMime } from './refb'

const bytes = (values: readonly number[]): Uint8Array => new Uint8Array(values)
const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('looksLikeImageBytes', () => {
  it('accepts raster image signatures when bytes start with known magic values', () => {
    expect(looksLikeImageBytes(bytes([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
    expect(looksLikeImageBytes(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(looksLikeImageBytes(bytes([0x47, 0x49, 0x46, 0x38]))).toBe(true)
    expect(looksLikeImageBytes(bytes([0x42, 0x4d, 0x00, 0x00]))).toBe(true)
    expect(looksLikeImageBytes(textBytes('RIFFxxxxWEBP'))).toBe(true)
  })

  it('rejects html, plain text, and too-short payloads when they are not images', () => {
    expect(looksLikeImageBytes(textBytes('<!doctype html><html></html>'))).toBe(false)
    expect(looksLikeImageBytes(textBytes('<html></html>'))).toBe(false)
    expect(looksLikeImageBytes(textBytes('not an image'))).toBe(false)
    expect(looksLikeImageBytes(bytes([0x89, 0x50, 0x4e]))).toBe(false)
  })

  it('keeps the existing svg text allowance while rejecting html-like text', () => {
    expect(looksLikeImageBytes(textBytes('<?xml version="1.0"?><svg></svg>'))).toBe(true)
    expect(looksLikeImageBytes(textBytes('  <svg viewBox="0 0 1 1"></svg>'))).toBe(true)
    expect(looksLikeImageBytes(textBytes('<HTML></HTML>'))).toBe(false)
  })
})

describe('sniffImageMime', () => {
  it('returns the mime type that matches the image signature', () => {
    expect(sniffImageMime(bytes([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(sniffImageMime(bytes([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(sniffImageMime(bytes([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif')
    expect(sniffImageMime(textBytes('RIFFxxxxWEBP'))).toBe('image/webp')
    expect(sniffImageMime(bytes([0x42, 0x4d]))).toBe('image/bmp')
  })

  it('returns null when bytes are not a known raster image', () => {
    expect(sniffImageMime(textBytes('<html></html>'))).toBeNull()
    expect(sniffImageMime(textBytes('<svg></svg>'))).toBeNull()
  })
})
