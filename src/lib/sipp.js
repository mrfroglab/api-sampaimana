/**
 * Parser and stage proposals for SIPP "Detil Perkara" pages (sipp.pn-*.go.id).
 *
 * SIPP sits behind reCAPTCHA, so nothing here fetches anything: an editor pastes the
 * page (HTML or plain copied text) and we read it. The parser is label driven: it
 * looks for the Indonesian field labels instead of depending on markup, so layout
 * changes on SIPP's side should not break it. It never throws.
 */
const crypto = require('crypto');
const { jakartaDay, startOfJakartaDay } = require('./dates');
const { STATUS_ORDER } = require('./labels');

const SEP = '\t'; // cell separator in the normalised text
const BR = '\u0001'; // line break inside one cell

/* ---------- dates ---------- */

const MONTHS = {
  januari: 1, jan: 1, january: 1,
  februari: 2, feb: 2, pebruari: 2, february: 2,
  maret: 3, mar: 3, march: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  agustus: 8, agu: 8, agt: 8, agust: 8, aug: 8, august: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10, october: 10,
  november: 11, nov: 11, nop: 11,
  desember: 12, des: 12, dec: 12, december: 12,
};

const pad = (n) => String(n).padStart(2, '0');

const validDay = (y, m, d) => {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const toIso = (y, m, d) => (validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);

const DATE_PATTERNS = [
  // 2025-03-03
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, pick: (m) => toIso(+m[1], +m[2], +m[3]) },
  // 03-03-2025, 03/03/2025, 03.03.2025
  { re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/, pick: (m) => toIso(+m[3], +m[2], +m[1]) },
  // 03 Maret 2025, 03 Mar. 2025, 3 Mar 25 is not supported (ambiguous)
  {
    re: /\b(\d{1,2})\s*([A-Za-z]{3,10})\.?,?\s+(\d{4})\b/,
    pick: (m) => {
      const month = MONTHS[m[2].toLowerCase()];
      return month ? toIso(+m[3], month, +m[1]) : null;
    },
  },
];

/** Finds the first date in a string and returns "YYYY-MM-DD" (or null). */
const parseIndoDate = (text) => {
  const s = String(text ?? '');
  let best = null;
  for (const { re, pick } of DATE_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const iso = pick(m);
    if (iso && (!best || m.index < best.index)) best = { index: m.index, iso };
  }
  return best?.iso ?? null;
};

const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?\s*(?:WIB|WITA|WIT)?\b/i;

/** First "HH:MM" in a string (also accepts "09.30"); null when none. Skips date-like "03.03.2025". */
const parseTime = (text) => {
  const s = String(text ?? '').replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, ' ');
  const m = TIME_RE.exec(s);
  return m ? `${pad(+m[1])}:${m[2]}` : null;
};

/* ---------- HTML / text normalisation ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };

const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

const looksLikeHtml = (s) => /<\s*(?:html|head|body|table|tr|td|th|div|span|p|h[1-6]|br|ul|li|title)\b[^>]*>/i.test(s);

const cleanCell = (s) => s.replace(/[ \t\r\f\v ]+/g, ' ').trim();

/** Turns HTML into text lines where table cells are tab separated. Also returns <title>. */
const htmlToLines = (html) => {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, BR)
    .replace(/<\/\s*(td|th)\s*>/gi, SEP)
    .replace(/<\/\s*(tr|p|div|li|ul|ol|table|thead|tbody|h[1-6]|caption|section|article|header|footer|form|dt|dd|dl)\s*>/gi, '\n')
    .replace(/<\s*(tr|p|div|li|h[1-6]|table|caption|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return { lines: s.split(/\r?\n/), title: title ? cleanCell(decodeEntities(title.replace(/<[^>]*>/g, ''))) : null };
};

const textToLines = (text) => ({ lines: text.split(/\r?\n/), title: null });

const stripBr = (c) => c.replace(new RegExp(`^${BR}+|${BR}+$`, 'g'), '').trim();

/** Positional cells of a table row: empty cells are kept so column indexes stay valid. */
const rawCells = (line) => {
  const cells = line.split(SEP).map((c) => stripBr(cleanCell(c)));
  while (cells.length && !cells[cells.length - 1]) cells.pop();
  return cells;
};

/** A line becomes an array of non-empty cells; a lone ":" cell (label : value layout) is dropped. */
const toCells = (line) =>
  line
    .split(SEP)
    .map(cleanCell)
    .map((c) => c.replace(new RegExp(`^${BR}+|${BR}+$`, 'g'), '').trim())
    .filter((c) => c && c !== ':' && c !== '：');

/* ---------- labels ---------- */

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

const LABELS = {
  caseNumber: ['nomorperkara', 'noperkara', 'nomorperkarasipp'],
  registeredAt: ['tanggalpendaftaran', 'tglpendaftaran', 'tanggalregister', 'tanggalpendaftaranperkara'],
  classification: ['klasifikasiperkara', 'klasifikasi', 'jenisperkara', 'katagoriperkara', 'kategoriperkara'],
  statusText: ['statusperkara', 'statusperkaraterakhir'],
  verdictDate: ['tanggalputusan', 'tglputusan', 'tanggalpembacaanputusan'],
  verdictSummary: ['amarputusan', 'amar', 'bunyiputusan'],
};

const PARTY_LABELS = {
  penuntutumum: 'Penuntut Umum',
  jaksapenuntutumum: 'Penuntut Umum',
  terdakwa: 'Terdakwa',
  penggugat: 'Penggugat',
  tergugat: 'Tergugat',
  turuttergugat: 'Turut Tergugat',
  pemohon: 'Pemohon',
  termohon: 'Termohon',
  terdakwaterpidana: 'Terdakwa',
  pembanding: 'Pembanding',
  terbanding: 'Terbanding',
};

// Anything that starts a new field, used to know where a multi line value stops.
const ALL_LABELS = new Set([
  ...Object.values(LABELS).flat(),
  ...Object.keys(PARTY_LABELS),
  'jadwalsidang', 'nomorperkarapenahanan', 'lamaproses', 'prosesterakhir', 'tanggalpenahanan', 'tanggalpenetapan',
  'penetapanmajelishakim', 'hakimketua', 'majelishakim', 'panitera', 'paniteragantipengganti', 'paniterapengganti',
  'riwayatperkara', 'saksi', 'barangbukti', 'catatan', 'keterangan', 'jenispenahanan', 'dakwaan', 'kuasahukum',
]);

const labelOf = (cell) => {
  const text = cell.replace(/[:：]\s*$/, '').trim();
  return { text, key: norm(text) };
};

/** Splits "Label: value" inside one cell (plain text pastes). */
const splitInline = (cell, keys) => {
  const m = /^([A-Za-z][A-Za-z .\/()-]{2,40}?)\s*[:：]\s*(.+)$/.exec(cell);
  if (m && keys.has(norm(m[1]))) return [m[1], m[2]];
  // "Nomor Perkara 27/Pid..." without any separator
  const lower = cell.toLowerCase();
  for (const k of keys) {
    const words = LABEL_TEXT[k];
    if (words && lower.startsWith(`${words} `)) return [cell.slice(0, words.length), cell.slice(words.length).trim()];
  }
  return null;
};

// Human spelling of each normalised label, only used for the "no separator" fallback.
const LABEL_TEXT = {
  nomorperkara: 'nomor perkara',
  noperkara: 'no perkara',
  tanggalpendaftaran: 'tanggal pendaftaran',
  klasifikasiperkara: 'klasifikasi perkara',
  statusperkara: 'status perkara',
  tanggalputusan: 'tanggal putusan',
  amarputusan: 'amar putusan',
  penuntutumum: 'penuntut umum',
  terdakwa: 'terdakwa',
  penggugat: 'penggugat',
  tergugat: 'tergugat',
  turuttergugat: 'turut tergugat',
  pemohon: 'pemohon',
  termohon: 'termohon',
};

/**
 * Reads the document into [{ key, text, value, rest }] entries: every line whose first
 * cell is a known label, with the value taken from the next cell, the text after a
 * colon, or (when empty) the following lines up to the next label.
 */
const collectFields = (lines) => {
  const entries = [];
  const cellsPerLine = lines.map(toCells);
  const known = new Set(ALL_LABELS);
  for (let i = 0; i < cellsPerLine.length; i += 1) {
    const cells = cellsPerLine[i];
    if (!cells.length) continue;
    let head = cells[0];
    let valueCells = cells.slice(1, 2);
    let { key } = labelOf(head);
    if (!known.has(key)) {
      const inline = splitInline(head, known);
      if (!inline) continue;
      key = norm(inline[0]);
      head = inline[0];
      valueCells = [inline[1]];
    }
    let value = valueCells.join(' ').trim();
    const extra = [];
    // Value on the following lines (label alone on its line, or multi line value).
    let j = i + 1;
    const multi = key === 'amarputusan' || key === 'amar' || !value;
    if (multi) {
      while (j < cellsPerLine.length && extra.length < 40) {
        const next = cellsPerLine[j];
        if (!next.length) {
          if (value || extra.length) break;
          j += 1;
          if (j - i > 3) break;
          continue;
        }
        if (known.has(labelOf(next[0]).key) || (next.length === 1 && splitInline(next[0], known))) break;
        extra.push(next.join(' '));
        j += 1;
        if (!multi) break;
      }
    }
    // Numbered continuation lines for parties ("2. Nama").
    if (PARTY_LABELS[key]) {
      while (j < cellsPerLine.length && cellsPerLine[j].length === 1 && /^\d+[.)]\s+\S/.test(cellsPerLine[j][0])) {
        extra.push(cellsPerLine[j][0]);
        j += 1;
      }
    }
    entries.push({ key, label: head, value, extra, line: i });
  }
  return entries;
};

const firstEntry = (entries, aliases) => entries.find((e) => aliases.includes(e.key) && (e.value || e.extra.length));

const entryText = (e) => [e.value, ...e.extra].filter(Boolean).join(' ').replace(new RegExp(BR, 'g'), ' ').replace(/\s+/g, ' ').trim();

/* ---------- court ---------- */

const COURT_RE = /\b(Pengadilan\s+(?:Negeri|Tinggi|Tata\s+Usaha\s+Negara|Agama|Niaga|Militer|Hubungan\s+Industrial|Tindak\s+Pidana\s+Korupsi)|PN|PT|PTUN|PA|PHI|Tipikor)\.?\s+([A-Z][A-Za-z.'’]*(?:\s+[A-Z][A-Za-z.'’]*){0,3})/;

const ABBREV = [
  [/^Pengadilan\s+Negeri/i, 'PN'],
  [/^Pengadilan\s+Tinggi/i, 'PT'],
  [/^Pengadilan\s+Tata\s+Usaha\s+Negara/i, 'PTUN'],
  [/^Pengadilan\s+Agama/i, 'PA'],
  [/^Pengadilan\s+Niaga/i, 'PN Niaga'],
  [/^Pengadilan\s+Hubungan\s+Industrial/i, 'PHI'],
  [/^Pengadilan\s+Tindak\s+Pidana\s+Korupsi/i, 'Tipikor'],
  [/^Pengadilan\s+Militer/i, 'Dilmil'],
];

const normCourt = (kind, name) => {
  let prefix = kind.replace(/\./g, '');
  for (const [re, abbr] of ABBREV) {
    if (re.test(prefix)) {
      prefix = abbr;
      break;
    }
  }
  return `${prefix} ${name.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '')}`;
};

const findCourt = (title, lines) => {
  // The <title> ("SIPP - Pengadilan Negeri Jakarta Pusat") may mention the court anywhere.
  const fromTitle = title ? COURT_RE.exec(title) : null;
  if (fromTitle) return normCourt(fromTitle[1], fromTitle[2]);
  // Otherwise only a short stand-alone header line near the top that *starts* with the court,
  // so party names such as "PT Bank Sumatera" or the case number line are never mistaken for it.
  for (const line of lines.slice(0, 40)) {
    const cells = toCells(line);
    if (cells.length !== 1 || cells[0].length > 80 || cells[0].includes(':')) continue;
    const m = COURT_RE.exec(cells[0]);
    if (m && m.index === 0) return normCourt(m[1], m[2]);
  }
  return null;
};

const COURT_FROM_NUMBER_RE = /\/\s*(PN|PT|PTUN|PA|PHI)[.\s-]*([A-Za-z][A-Za-z. ]{1,24})\s*$/;

/* ---------- parties ---------- */

const splitNames = (text) =>
  text
    .split(new RegExp(`${BR}|\\n|;`))
    .map((n) => n.replace(/^\s*\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((n) => n && n !== '-');

const collectParties = (entries) => {
  const out = [];
  const seen = new Set();
  entries
    .filter((e) => PARTY_LABELS[e.key])
    .forEach((e) => {
      const joined = [e.value, ...e.extra].join(BR);
      splitNames(joined).forEach((name) => {
        const role = PARTY_LABELS[e.key];
        const id = `${role}|${name.toLowerCase()}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ role, name: name.slice(0, 200) });
      });
    });
  return out;
};

/* ---------- schedule (Jadwal Sidang) ---------- */

const hasDate = (s) => parseIndoDate(s) !== null;

const mapHeader = (cells) => {
  const idx = {};
  cells.forEach((c, i) => {
    const k = norm(c);
    if (idx.date === undefined && /^(tanggal|tgl)/.test(k) && !/sampai|sd/.test(k)) idx.date = i;
    else if (idx.agenda === undefined && /agenda|acara|kegiatan/.test(k)) idx.agenda = i;
    else if (idx.room === undefined && /ruang/.test(k)) idx.room = i;
    else if (idx.time === undefined && /^(jam|pukul|waktu)/.test(k)) idx.time = i;
  });
  return idx.date !== undefined && idx.agenda !== undefined ? idx : null;
};

const ROOM_RE = /\b(Ruang(?:an)?\b.*)$/i;

/** Heuristic row reader for text pasted without a recognisable header. */
const rowFromCells = (cells) => {
  const joined = cells.join(' ');
  const date = parseIndoDate(joined);
  if (!date) return null;
  const time = parseTime(cells.filter((c) => !hasDate(c) || /\d[:.]\d{2}/.test(c)).join(' ')) ?? parseTime(joined);
  const rest = cells.filter((c) => !hasDate(c) && !/^\d{1,3}$/.test(c) && !/^\d{1,2}[:.]\d{2}(\s*(WIB|WITA|WIT))?$/i.test(c));
  let agenda;
  let room = null;
  if (rest.length) {
    agenda = rest[0];
    room = rest.find((c, i) => i > 0 && /ruang/i.test(c)) ?? rest[1] ?? null;
  } else {
    // Single text line: "1 Senin, 03 Mar. 2025 09:00 Pembacaan Dakwaan Ruang Utama"
    const stripped = joined
      .replace(/^\s*\d{1,3}\s+/, '')
      .replace(/(?:Senin|Selasa|Rabu|Kamis|Jumat|Jum'at|Sabtu|Minggu|Ahad),?\s*/i, '')
      .replace(/\b\d{1,2}\s*[A-Za-z]{3,10}\.?,?\s+\d{4}\b/, '')
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/, '')
      .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/, '')
      .replace(TIME_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
    const rm = ROOM_RE.exec(stripped);
    room = rm ? rm[1] : null;
    agenda = rm ? stripped.slice(0, rm.index).trim() : stripped;
  }
  return { date, time, agenda: agenda || null, room };
};

const collectSchedule = (lines, warnings) => {
  const rows = [];
  const raws = lines.map(rawCells);
  const cellsPerLine = raws.map((r) => r.filter((c) => c && c !== ':'));
  const start = cellsPerLine.findIndex((c) => c.length && norm(c[0]).startsWith('jadwalsidang') && c.length <= 2);
  if (start === -1) return rows;
  let header = null;
  let junk = 0;
  for (let i = start + 1; i < cellsPerLine.length; i += 1) {
    const cells = cellsPerLine[i];
    if (!cells.length) continue;
    const joined = cells.join(' ');
    if (!hasDate(joined)) {
      const mapped = mapHeader(raws[i].length > 1 ? raws[i] : joined.split(/\s{2,}/));
      if (mapped) {
        header = mapped;
        continue;
      }
      // A non-date line: tolerate a few before the first row, otherwise the table has ended.
      junk += 1;
      if (rows.length || junk > 3 || ALL_LABELS.has(labelOf(cells[0]).key)) break;
      continue;
    }
    let row = null;
    const raw = raws[i];
    if (header && raw.length > Math.max(header.date, header.agenda)) {
      const date = parseIndoDate(raw[header.date]);
      if (date) {
        row = {
          date,
          time: parseTime(header.time !== undefined ? raw[header.time] : raw[header.date]),
          agenda: raw[header.agenda]?.replace(/\s+/g, ' ') || null,
          room: header.room !== undefined ? raw[header.room] || null : null,
        };
      }
    }
    row ||= rowFromCells(cells);
    if (row) rows.push({ ...row, agenda: row.agenda?.slice(0, 300) ?? null, room: row.room?.slice(0, 120) ?? null });
  }
  if (!rows.length) warnings.push('Tabel "Jadwal Sidang" ditemukan tetapi tidak ada baris tanggal yang bisa dibaca.');
  return rows;
};

/* ---------- main parser ---------- */

const EMPTY = () => ({
  caseNumber: null,
  court: null,
  classification: null,
  registeredAt: null,
  statusText: null,
  parties: [],
  schedule: [],
  verdictDate: null,
  verdictSummary: null,
  warnings: [],
});

/**
 * Parses a SIPP "Detil Perkara" page given as HTML or as plain copied text.
 * Always returns an object; unknown input simply yields nulls plus warnings.
 */
const parseSipp = (input) => {
  const result = EMPTY();
  try {
    const text = typeof input === 'string' ? input : '';
    if (!text.trim()) {
      result.warnings.push('Teks halaman SIPP kosong.');
      return result;
    }
    const { lines, title } = looksLikeHtml(text) ? htmlToLines(text) : textToLines(text);
    const entries = collectFields(lines);

    const get = (name) => {
      const e = firstEntry(entries, LABELS[name]);
      return e ? entryText(e) : null;
    };

    result.caseNumber = get('caseNumber');
    result.classification = get('classification');
    result.statusText = get('statusText');

    const registered = get('registeredAt');
    if (registered) {
      result.registeredAt = parseIndoDate(registered);
      if (!result.registeredAt) result.warnings.push(`Tanggal pendaftaran tidak bisa dibaca: "${registered.slice(0, 60)}".`);
    }
    const verdictDate = get('verdictDate');
    if (verdictDate) {
      result.verdictDate = parseIndoDate(verdictDate);
      if (!result.verdictDate) result.warnings.push(`Tanggal putusan tidak bisa dibaca: "${verdictDate.slice(0, 60)}".`);
    }
    const amar = get('verdictSummary');
    if (amar) result.verdictSummary = amar.slice(0, 2000);

    result.parties = collectParties(entries);
    result.court = findCourt(title, lines);
    if (!result.court && result.caseNumber) {
      const m = COURT_FROM_NUMBER_RE.exec(result.caseNumber);
      if (m) {
        result.court = `${m[1]} ${m[2].trim()}`;
        result.warnings.push('Nama pengadilan diambil dari singkatan pada nomor perkara; periksa ejaannya.');
      }
    }
    result.schedule = collectSchedule(lines, result.warnings);

    const found = [result.caseNumber, result.registeredAt, result.statusText, result.classification].some(Boolean) || result.schedule.length || result.parties.length;
    if (!found) {
      result.warnings.push('Tidak ada data SIPP yang dikenali. Pastikan yang ditempel adalah halaman "Detil Perkara".');
    } else {
      if (!result.caseNumber) result.warnings.push('Nomor perkara tidak ditemukan.');
      if (!result.registeredAt) result.warnings.push('Tanggal pendaftaran tidak ditemukan.');
      if (!result.court) result.warnings.push('Nama pengadilan tidak ditemukan.');
      if (!result.schedule.length && !result.warnings.some((w) => w.includes('Jadwal Sidang'))) {
        result.warnings.push('Jadwal sidang tidak ditemukan.');
      }
    }
  } catch (err) {
    result.warnings.push(`Gagal membaca halaman SIPP: ${err.message}`);
  }
  return result;
};

/* ---------- proposals ---------- */

const VERDICT_STATUS_RE = /putusan|minutasi|\bbht\b|inkracht|berkekuatan\s+hukum/i;
const VERDICT_AGENDA_RE = /(?:pembacaan|pengucapan)\s+putusan|putusan\s+akhir|^putusan$/i;

const scheduleInstant = (row) => new Date(`${row.date}T${row.time || '00:00'}:00+07:00`);

const proposalKey = ({ stageType, startedAt, dueAt }) =>
  crypto
    .createHash('sha1')
    .update(`${stageType}|${jakartaDay(startedAt)}|${dueAt ? jakartaDay(dueAt) : ''}`)
    .digest('hex')
    .slice(0, 12);

const fmtId = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
};

/**
 * Turns parsed SIPP data into stages the editor can approve. Pure: `existingStages`
 * is [{ stageType, startedAt, dueAt?, status? }] and `now` is injectable.
 * Duplicates of an existing stage (same type, same start day) are dropped.
 */
const proposeStages = (parsed, existingStages = [], now = new Date()) => {
  const p = parsed || EMPTY();
  const existing = (existingStages || []).map((s) => ({ ...s, startedAt: new Date(s.startedAt), dueAt: s.dueAt ? new Date(s.dueAt) : null }));
  const today = jakartaDay(now);
  const courtLabel = p.court || 'pengadilan';
  const proposals = [];

  const schedule = (p.schedule || []).filter((r) => r?.date).sort((a, b) => scheduleInstant(a) - scheduleInstant(b));
  const upcoming = schedule.find((r) => r.date >= today) ?? null;

  // Verdict: explicit date, a past "Pembacaan Putusan" hearing, or a status that says so.
  const pastVerdictHearing = [...schedule].reverse().find((r) => r.date <= today && VERDICT_AGENDA_RE.test((r.agenda || '').trim()));
  const statusSaysVerdict = VERDICT_STATUS_RE.test(p.statusText || '');
  let verdictDay = p.verdictDate || pastVerdictHearing?.date || null;
  if (!verdictDay && statusSaysVerdict) {
    verdictDay = [...schedule].reverse().find((r) => r.date <= today)?.date ?? p.registeredAt ?? today;
  }
  const decided = Boolean(verdictDay);

  const add = (stage) => {
    const startedAt = stage.startedAt.toISOString();
    const dueAt = stage.dueAt ? stage.dueAt.toISOString() : null;
    const item = { stageType: stage.stageType, status: stage.status, title: stage.title, summary: stage.summary, startedAt, dueAt };
    const day = jakartaDay(stage.startedAt);
    if (existing.some((s) => s.stageType === item.stageType && jakartaDay(s.startedAt) === day)) return;
    proposals.push({ ...item, key: proposalKey(item) });
  };

  // A stage may become the active one unless the case already reached a later phase
  // (e.g. a PUTUSAN stage exists and SIPP only tells us about the registration). Dates are
  // not compared: the stage auto-created with a case is dated "today", not when it began.
  const canBeActive = (stageType) => !existing.some((s) => STATUS_ORDER.indexOf(s.stageType) > STATUS_ORDER.indexOf(stageType));

  let registrationEmitted = false;
  if (p.registeredAt) {
    const startedAt = startOfJakartaDay(p.registeredAt);
    const status = !decided && canBeActive('PERSIDANGAN') ? 'AKTIF' : 'SELESAI';
    const bits = [`Perkara terdaftar di ${courtLabel} pada ${fmtId(p.registeredAt)}${p.caseNumber ? ` dengan nomor ${p.caseNumber}` : ''}.`];
    if (p.classification) bits.push(`Klasifikasi: ${p.classification}.`);
    if (upcoming && !decided) {
      bits.push(`Sidang berikutnya ${fmtId(upcoming.date)}${upcoming.time ? ` pukul ${upcoming.time}` : ''}${upcoming.agenda ? `: ${upcoming.agenda}` : ''}.`);
    }
    bits.push('Diimpor dari SIPP.');
    const before = proposals.length;
    add({
      stageType: 'PERSIDANGAN',
      status,
      title: `Perkara terdaftar di ${courtLabel}`,
      summary: bits.join(' '),
      startedAt,
      dueAt: status === 'AKTIF' && upcoming && !decided ? scheduleInstant(upcoming) : null,
    });
    registrationEmitted = proposals.length > before;
  }

  // The case is already in court but the registration stage exists: track the next hearing date.
  if (!registrationEmitted && upcoming && !decided) {
    const dueAt = scheduleInstant(upcoming);
    const dueDay = jakartaDay(dueAt);
    const active = existing.find((s) => s.stageType === 'PERSIDANGAN' && s.status === 'AKTIF');
    const alreadyTracked = existing.some((s) => s.stageType === 'PERSIDANGAN' && s.dueAt && jakartaDay(s.dueAt) === dueDay);
    if (active && !alreadyTracked) {
      add({
        stageType: 'PERSIDANGAN',
        status: 'AKTIF',
        title: upcoming.agenda ? `Sidang: ${upcoming.agenda}` : 'Sidang berikutnya',
        summary: `Sidang dijadwalkan ${fmtId(upcoming.date)}${upcoming.time ? ` pukul ${upcoming.time}` : ''}${upcoming.room ? ` di ${upcoming.room}` : ''}. Diimpor dari SIPP.`,
        startedAt: startOfJakartaDay(today),
        dueAt,
      });
    }
  }

  if (decided) {
    const startedAt = startOfJakartaDay(verdictDay);
    const summaryBits = [];
    if (p.verdictSummary) summaryBits.push(p.verdictSummary);
    else if (pastVerdictHearing?.agenda) summaryBits.push(pastVerdictHearing.agenda);
    else if (p.statusText) summaryBits.push(`Status perkara di SIPP: ${p.statusText}.`);
    summaryBits.push('Diimpor dari SIPP.');
    add({
      stageType: 'PUTUSAN',
      status: canBeActive('PUTUSAN') ? 'AKTIF' : 'SELESAI',
      title: `Putusan ${courtLabel}`,
      summary: summaryBits.join(' ').slice(0, 4900),
      startedAt,
      dueAt: null,
    });
  }

  return proposals.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt) || (a.stageType === 'PUTUSAN') - (b.stageType === 'PUTUSAN'));
};

module.exports = { parseSipp, proposeStages, parseIndoDate, parseTime, proposalKey };
