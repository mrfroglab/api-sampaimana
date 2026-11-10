import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sipp from '../../src/lib/sipp.js';

const { parseSipp, proposeStages, parseIndoDate, parseTime } = sipp;
const fixture = (name) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sipp', name), 'utf8');
const NOW = new Date('2025-06-01T03:00:00Z'); // 10:00 Jakarta

describe('parseIndoDate / parseTime', () => {
  it.each([
    ['Senin, 03 Mar. 2025', '2025-03-03'],
    ['03 Maret 2025', '2025-03-03'],
    ['3 Maret 2025', '2025-03-03'],
    ['2025-03-03', '2025-03-03'],
    ['03-03-2025', '2025-03-03'],
    ['03/03/2025', '2025-03-03'],
    ['Kamis, 12 Des. 2024 09:30', '2024-12-12'],
    ['17 Agustus 2024', '2024-08-17'],
    ['5 Okt 2023', '2023-10-05'],
  ])('reads %s', (text, iso) => {
    expect(parseIndoDate(text)).toBe(iso);
  });

  it('rejects impossible or missing dates', () => {
    expect(parseIndoDate('31 Februari 2025')).toBeNull();
    expect(parseIndoDate('32-01-2025')).toBeNull();
    expect(parseIndoDate('tanggal belum ada')).toBeNull();
    expect(parseIndoDate(null)).toBeNull();
    expect(parseIndoDate('12 Foo 2025')).toBeNull();
  });

  it('reads times in both notations and ignores dates written with dots', () => {
    expect(parseTime('Senin, 02 Des. 2099 09:30')).toBe('09:30');
    expect(parseTime('10.30 WIB')).toBe('10:30');
    expect(parseTime('03.03.2025')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
});

describe('parseSipp: html fixtures', () => {
  it('reads a pidana (tipikor) page: header, parties and the Jadwal Sidang table', () => {
    const p = parseSipp(fixture('pidana-tipikor.html'));
    expect(p).toMatchObject({
      caseNumber: '27/Pid.Sus-TPK/2025/PN Jkt.Pst',
      court: 'PN Jakarta Pusat',
      classification: 'Korupsi',
      registeredAt: '2025-03-03',
      statusText: 'Persidangan',
      verdictDate: null,
    });
    expect(p.parties.filter((x) => x.role === 'Terdakwa').map((x) => x.name)).toEqual(['Budi Santoso bin Harun', 'Siti Rahmawati binti Anwar']);
    expect(p.parties.filter((x) => x.role === 'Penuntut Umum')).toHaveLength(2);
    expect(p.schedule).toEqual([
      { date: '2025-03-10', time: null, agenda: 'Pembacaan Dakwaan', room: 'Ruang Sidang Prof. Dr. Kusumah Atmadja' },
      { date: '2025-03-17', time: null, agenda: 'Pemeriksaan Saksi', room: 'Ruang Sidang Prof. Dr. Kusumah Atmadja' },
      { date: '2025-11-24', time: null, agenda: 'Pemeriksaan Saksi & Ahli', room: 'Ruang Sidang 3' },
    ]);
    expect(p.warnings).toEqual([]);
  });

  it('reads a perdata page with a colon column and mixed date formats', () => {
    const p = parseSipp(fixture('perdata-ptun.html'));
    expect(p).toMatchObject({ caseNumber: '115/Pdt.G/2025/PN Sby', court: 'PN Surabaya', registeredAt: '2025-02-12', classification: 'Perbuatan Melawan Hukum' });
    expect(p.parties.map((x) => x.role)).toEqual(['Penggugat', 'Tergugat', 'Turut Tergugat']);
    expect(p.schedule.map((r) => r.date)).toEqual(['2025-02-26', '2025-03-05', '2099-12-03']);
    expect(p.schedule[1]).toMatchObject({ agenda: 'Pembacaan Gugatan', room: 'Ruang Sidang Cakra' });
  });

  it('reads the verdict date and amar from a decided case', () => {
    const p = parseSipp(fixture('pidana-putusan.html'));
    expect(p).toMatchObject({ statusText: 'Minutasi', verdictDate: '2024-12-12' });
    expect(p.verdictSummary).toMatch(/pidana penjara selama 2 \(dua\) tahun/);
  });

  it('ignores scripts, styles and navigation noise', () => {
    const p = parseSipp(fixture('pidana-tipikor.html'));
    expect(JSON.stringify(p)).not.toMatch(/csrf|document\.write|padding/);
  });
});

describe('parseSipp: plain copied text', () => {
  it('reads tab separated text (select-all + copy)', () => {
    const p = parseSipp(fixture('pidana-tab.txt'));
    expect(p).toMatchObject({ caseNumber: '88/Pid.Sus/2025/PN Jkt.Sel', court: 'PN Jakarta Selatan', registeredAt: '2025-01-15', statusText: 'Persidangan' });
    expect(p.schedule).toEqual([
      { date: '2025-01-22', time: null, agenda: 'Pembacaan Dakwaan', room: 'Ruang Sidang 2' },
      { date: '2099-12-02', time: '09:30', agenda: 'Pemeriksaan Saksi', room: 'Ruang Sidang 2' },
    ]);
  });

  it('reads "Label: value" lines and space separated schedule rows', () => {
    const p = parseSipp(fixture('perdata-bebas.txt'));
    expect(p).toMatchObject({ caseNumber: '301/Pdt.G/2025/PN Mdn', court: 'PN Medan', registeredAt: '2025-03-03', classification: 'Wanprestasi' });
    expect(p.parties).toEqual([
      { role: 'Penggugat', name: 'CV Karya Mandiri' },
      { role: 'Tergugat', name: 'PT Bank Sumatera Utama' },
    ]);
    expect(p.schedule).toEqual([
      { date: '2025-03-17', time: '09:00', agenda: 'Pembacaan Gugatan', room: 'Ruang Sidang Cakra' },
      { date: '2099-12-01', time: '10:30', agenda: 'Jawaban Tergugat', room: 'Ruang Sidang Cakra' },
    ]);
  });

  it('takes a value from the next line when the label stands alone', () => {
    const p = parseSipp('Nomor Perkara\n12/Pid.B/2025/PN Mks\nStatus Perkara\nPersidangan\n');
    expect(p.caseNumber).toBe('12/Pid.B/2025/PN Mks');
    expect(p.statusText).toBe('Persidangan');
  });

  it('falls back to the court abbreviation in the case number', () => {
    const p = parseSipp('Nomor Perkara\t5/Pid.B/2025/PN Mks');
    expect(p.court).toBe('PN Mks');
    expect(p.warnings.join()).toMatch(/singkatan/);
  });
});

describe('parseSipp: tolerance', () => {
  it('never throws and always returns the full shape', () => {
    const inputs = ['', '   ', null, undefined, 42, {}, '<<<>>>', '<td>', 'Nomor Perkara', 'Jadwal Sidang', '\t\t\t', '\u0001'.repeat(50), 'a'.repeat(100000)];
    for (const input of inputs) {
      const p = parseSipp(input);
      expect(Array.isArray(p.warnings)).toBe(true);
      expect(Array.isArray(p.schedule)).toBe(true);
      expect(Array.isArray(p.parties)).toBe(true);
      expect(p).toHaveProperty('caseNumber');
    }
  });

  it('warns when nothing is recognised', () => {
    const p = parseSipp('Halo dunia, ini bukan halaman SIPP.');
    expect(p.caseNumber).toBeNull();
    expect(p.warnings.join()).toMatch(/Tidak ada data SIPP/);
  });

  it('warns about an unreadable registration date but keeps the rest', () => {
    const p = parseSipp('Nomor Perkara\t1/Pid.B/2025/PN Jkt.Pst\nTanggal Pendaftaran\tbelum ada');
    expect(p.caseNumber).toBe('1/Pid.B/2025/PN Jkt.Pst');
    expect(p.registeredAt).toBeNull();
    expect(p.warnings.join()).toMatch(/Tanggal pendaftaran tidak bisa dibaca/);
  });

  it('survives a large page quickly', () => {
    const row = '<tr><td>Foo</td><td>Bar &amp; Baz</td></tr>\n';
    const html = `<html><body><table>${row.repeat(30000)}<tr><td>Nomor Perkara</td><td>9/Pid.B/2025/PN Jkt.Pst</td></tr></table></body></html>`;
    const started = Date.now();
    const p = parseSipp(html);
    expect(p.caseNumber).toBe('9/Pid.B/2025/PN Jkt.Pst');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('is label based: reordered rows and extra columns still parse', () => {
    const html = '<table><tr><td>Status Perkara</td><td>Persidangan</td><td>extra</td></tr><tr><td>Nomor Perkara</td><td>7/Pdt.G/2025/PN Smg</td></tr></table>';
    const p = parseSipp(html);
    expect(p).toMatchObject({ statusText: 'Persidangan', caseNumber: '7/Pdt.G/2025/PN Smg' });
  });
});

describe('proposeStages', () => {
  const pidana = () => parseSipp(fixture('pidana-tab.txt'));

  it('proposes an active PERSIDANGAN stage whose dueAt is the next upcoming hearing', () => {
    const proposals = proposeStages(pidana(), [], NOW);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      stageType: 'PERSIDANGAN',
      status: 'AKTIF',
      title: 'Perkara terdaftar di PN Jakarta Selatan',
      startedAt: '2025-01-14T17:00:00.000Z', // 15 Jan 00:00 Jakarta
      dueAt: '2099-12-02T02:30:00.000Z', // 09:30 Jakarta
    });
    expect(proposals[0].summary).toMatch(/Diimpor dari SIPP/);
    expect(Object.keys(proposals[0]).sort()).toEqual(['dueAt', 'key', 'stageType', 'startedAt', 'status', 'summary', 'title']);
  });

  it('leaves dueAt empty when every hearing is in the past', () => {
    const [p] = proposeStages(pidana(), [], new Date('2100-01-01T00:00:00Z'));
    expect(p.dueAt).toBeNull();
  });

  it('proposes registration (closed) plus PUTUSAN for a decided case', () => {
    const proposals = proposeStages(parseSipp(fixture('pidana-putusan.html')), [], NOW);
    expect(proposals.map((p) => [p.stageType, p.status])).toEqual([
      ['PERSIDANGAN', 'SELESAI'],
      ['PUTUSAN', 'AKTIF'],
    ]);
    expect(proposals[1].startedAt).toBe('2024-12-11T17:00:00.000Z');
    expect(proposals[1].summary).toMatch(/pidana penjara selama 2 \(dua\) tahun/);
    expect(proposals[0].dueAt).toBeNull();
  });

  it('treats a past "Pembacaan Putusan" hearing as the verdict', () => {
    const parsed = { ...pidana(), schedule: [{ date: '2025-05-20', time: null, agenda: 'Pembacaan Putusan', room: null }] };
    const verdict = proposeStages(parsed, [], NOW).find((p) => p.stageType === 'PUTUSAN');
    expect(verdict.startedAt).toBe('2025-05-19T17:00:00.000Z');
  });

  it('does not treat a future "Pembacaan Putusan" hearing as a verdict', () => {
    const parsed = { ...pidana(), schedule: [{ date: '2025-07-20', time: null, agenda: 'Pembacaan Putusan', room: null }] };
    const proposals = proposeStages(parsed, [], NOW);
    expect(proposals.map((p) => p.stageType)).toEqual(['PERSIDANGAN']);
    expect(proposals[0].dueAt).toBe('2025-07-19T17:00:00.000Z');
  });

  it('uses the status alone (Putusan / Minutasi) when no date is given', () => {
    const proposals = proposeStages({ ...pidana(), statusText: 'Putusan', schedule: [] }, [], NOW);
    const verdict = proposals.find((p) => p.stageType === 'PUTUSAN');
    expect(verdict).toBeTruthy();
    expect(verdict.startedAt).toBe('2025-01-14T17:00:00.000Z'); // falls back to registration day
  });

  it('skips proposals that duplicate an existing stage of the same type on the same day', () => {
    const existing = [{ stageType: 'PERSIDANGAN', status: 'AKTIF', startedAt: new Date('2025-01-15T08:00:00+07:00'), dueAt: null }];
    expect(proposeStages(pidana(), existing, NOW).map((p) => p.title)).not.toContain('Perkara terdaftar di PN Jakarta Selatan');
    const other = [{ stageType: 'PENUNTUTAN', status: 'SELESAI', startedAt: new Date('2025-01-15T08:00:00+07:00'), dueAt: null }];
    expect(proposeStages(pidana(), other, NOW)).toHaveLength(1);
  });

  it('proposes the next hearing on its own when the registration stage already exists', () => {
    const existing = [{ stageType: 'PERSIDANGAN', status: 'AKTIF', startedAt: new Date('2025-01-15T00:00:00+07:00'), dueAt: null }];
    const [next] = proposeStages(pidana(), existing, NOW);
    expect(next).toMatchObject({ stageType: 'PERSIDANGAN', status: 'AKTIF', title: 'Sidang: Pemeriksaan Saksi', dueAt: '2099-12-02T02:30:00.000Z' });
    // ... and stops once that hearing is tracked.
    const tracked = [...existing, { stageType: 'PERSIDANGAN', status: 'AKTIF', startedAt: new Date(NOW), dueAt: new Date('2099-12-02T09:30:00+07:00') }];
    expect(proposeStages(pidana(), tracked, NOW)).toEqual([]);
  });

  it('never makes a historical stage active when the case already moved on', () => {
    const existing = [{ stageType: 'PUTUSAN', status: 'AKTIF', startedAt: new Date('2025-05-01T00:00:00+07:00'), dueAt: null }];
    const [p] = proposeStages(pidana(), existing, NOW);
    expect(p.status).toBe('SELESAI');
    expect(p.dueAt).toBeNull();
  });

  it('makes the stage active even when the case has an earlier-phase stage dated later (placeholder created today)', () => {
    const existing = [{ stageType: 'PENUNTUTAN', status: 'AKTIF', startedAt: new Date('2025-05-30T00:00:00+07:00'), dueAt: null }];
    expect(proposeStages(pidana(), existing, NOW)[0]).toMatchObject({ stageType: 'PERSIDANGAN', status: 'AKTIF' });
  });

  it('gives stable keys that depend only on type and days', () => {
    const a = proposeStages(pidana(), [], NOW)[0];
    const b = proposeStages(pidana(), [], new Date('2025-06-01T20:00:00Z'))[0];
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{12}$/);
    const decided = proposeStages(parseSipp(fixture('pidana-putusan.html')), [], NOW);
    expect(new Set(decided.map((p) => p.key)).size).toBe(decided.length);
  });

  it('returns nothing for empty or unrecognised input', () => {
    expect(proposeStages(parseSipp(''), [], NOW)).toEqual([]);
    expect(proposeStages(null, [], NOW)).toEqual([]);
  });
});
