import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { sniff, resolveStored, uploadRoot } from '../../src/middlewares/upload.js';

const hex = (h) => Buffer.from(h, 'hex');
const ascii = (s) => Buffer.from(s, 'latin1');

describe('sniff (magic bytes)', () => {
  it.each([
    ['jpg', hex('ffd8ffe000104a464946')],
    ['png', hex('89504e470d0a1a0a0000000d')],
    ['webp', ascii('RIFF\x00\x00\x00\x00WEBPVP8 ')],
    ['wav', ascii('RIFF\x00\x00\x00\x00WAVEfmt ')],
    ['pdf', ascii('%PDF-1.7\n')],
    ['mp3', ascii('ID3\x04\x00\x00\x00\x00\x00\x00')],
    ['mp3', hex('fffb90640000000000000000')],
  ])('detects %s', (ext, buf) => {
    expect(sniff(buf)?.ext).toBe(ext);
  });

  it('detects docx only when the zip contains a word/ entry', () => {
    const zipHeader = hex('504b0304140000000800');
    expect(sniff(Buffer.concat([zipHeader, ascii('....word/document.xml')]))?.ext).toBe('docx');
    expect(sniff(Buffer.concat([zipHeader, ascii('....payload.exe')]))).toBeNull();
  });

  it('rejects executables, scripts and HTML regardless of name', () => {
    expect(sniff(ascii('MZ\x90\x00\x03\x00\x00\x00'))).toBeNull();
    expect(sniff(hex('7f454c46020101000000'))).toBeNull();
    expect(sniff(ascii('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniff(ascii('#!/bin/sh\nrm -rf /'))).toBeNull();
  });

  it('handles tiny and empty buffers', () => {
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(hex('ff'))).toBeNull();
  });
});

describe('resolveStored', () => {
  it('resolves keys inside the upload root', () => {
    expect(resolveStored('contributions/a.pdf')).toBe(path.join(uploadRoot, 'contributions', 'a.pdf'));
  });
  it('refuses path traversal and absolute paths', () => {
    expect(() => resolveStored('../../etc/passwd')).toThrow(/tidak valid/);
    expect(() => resolveStored('/etc/passwd')).toThrow(/tidak valid/);
    expect(() => resolveStored('contributions/../../x')).toThrow(/tidak valid/);
  });
});
