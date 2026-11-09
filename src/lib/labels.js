const STATUS_ORDER = ['PELAPORAN', 'PENYIDIKAN', 'PENUNTUTAN', 'PERSIDANGAN', 'PUTUSAN'];

const STATUS_LABEL = {
  PELAPORAN: 'Pelaporan',
  PENYIDIKAN: 'Penyidikan',
  PENUNTUTAN: 'Penuntutan',
  PERSIDANGAN: 'Persidangan',
  PUTUSAN: 'Putusan',
};

const STAGE_STATUS_LABEL = { PENDING: 'Menunggu', AKTIF: 'Berjalan', SELESAI: 'Selesai' };

module.exports = { STATUS_ORDER, STATUS_LABEL, STAGE_STATUS_LABEL };
