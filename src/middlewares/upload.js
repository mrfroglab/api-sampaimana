const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const env = require('../config/env');
const { badRequest } = require('../lib/http');

const MAX_FILES = 5;
const MAX_SIZE = 10 * 1024 * 1024;

const uploadRoot = path.resolve(env.UPLOAD_DIR);

/**
 * Detects the real file type from its first bytes. The client-supplied
 * mimetype and extension are ignored, so a renamed executable is rejected.
 */
const sniff = (buf) => {
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return { ext: 'jpg', mime: 'image/jpeg' };
  if (hex.startsWith('89504e470d0a1a0a')) return { ext: 'png', mime: 'image/png' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (ascii.startsWith('%PDF-')) return { ext: 'pdf', mime: 'application/pdf' };
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }
  if (hex.startsWith('504b0304') && buf.includes(Buffer.from('word/'))) {
    return { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  return null;
};

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: MAX_FILES },
});

/** Accepts up to 5 files in field `proofFiles`, validates and stores them privately. */
const proofUpload = [
  multerUpload.array('proofFiles', MAX_FILES),
  async (req, res, next) => {
    const files = req.files || [];
    const stored = [];
    const dir = path.join(uploadRoot, 'contributions');
    // Validate every file before writing any, so a bad file leaves nothing behind.
    const typed = files.map((file) => {
      const type = sniff(file.buffer);
      if (!type) {
        throw badRequest(`File "${file.originalname}" tidak didukung. Gunakan JPG, PNG, WEBP, PDF, DOCX, MP3, atau WAV.`);
      }
      return { file, type };
    });
    if (files.length) await fs.mkdir(dir, { recursive: true });
    for (const { file, type } of typed) {
      const key = `contributions/${crypto.randomUUID()}.${type.ext}`;
      await fs.writeFile(path.join(uploadRoot, key), file.buffer, { mode: 0o640 });
      stored.push({
        key,
        fileName: path.basename(file.originalname).slice(0, 200),
        mimeType: type.mime,
        size: file.size,
      });
    }
    req.storedFiles = stored;
    next();
  },
];

/** Resolves a stored key to an absolute path, refusing anything outside the upload root. */
const resolveStored = (key) => {
  const full = path.resolve(uploadRoot, key);
  if (!full.startsWith(uploadRoot + path.sep)) throw badRequest('Path file tidak valid.');
  return full;
};

module.exports = { proofUpload, resolveStored, sniff, uploadRoot };
