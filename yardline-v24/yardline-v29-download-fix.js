/* Yard Line v29 - reliable proposal and attachment downloads */
(function () {
  'use strict';
  if (window.__yardlineV29DownloadFix) return;
  window.__yardlineV29DownloadFix = true;

  const fileTypes = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png';
  function filename(value) {
    return String(value || 'Document').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 180) || 'Document';
  }
  function safePart(value) {
    return filename(value).replace(/\s+/g, '_');
  }
  function reportError(title, details, error) {
    if (error) console.error('[Yard Line downloads]', title, error);
    notify(title, details);
  }
  function saveBlob(blob, name) {
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('File is empty or unavailable');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename(name);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 60000);
  }
  async function readBlob(id) {
    if (!id) return null;
    let db;
    try {
      db = await openFileDb();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_STORE, 'readonly');
        const request = tx.objectStore(FILE_STORE).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Unable to read attachment'));
        tx.onerror = () => reject(tx.error || new Error('Attachment read transaction failed'));
      });
      if (record && record.blob instanceof Blob && record.blob.size) return record.blob;
    } catch (error) {
      console.warn('[Yard Line downloads] IndexedDB read failed; trying in-session file', error);
    } finally {
      if (db) db.close();
    }
    const url = sessionFiles[id] || await getStoredFileUrl(id);
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Cannot read file data: HTTP ' + response.status);
    const blob = await response.blob();
    return blob.size ? blob : null;
  }
  async function persistBlob(id, file) {
    if (!file || !file.size) throw new Error('Choose a non-empty file');
    let db;
    try {
      db = await openFileDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_STORE, 'readwrite');
        tx.objectStore(FILE_STORE).put({ id, blob: file, name: file.name, type: file.type, updatedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Unable to store attachment'));
        tx.onabort = () => reject(tx.error || new Error('Attachment storage was aborted'));
      });
    } finally {
      if (db) db.close();
    }
    if (sessionFiles[id]) URL.revokeObjectURL(sessionFiles[id]);
    sessionFiles[id] = URL.createObjectURL(file);
  }
  async function downloadStored(id, name) {
    try {
      const blob = await readBlob(id);
      if (!blob) return reportError('Attachment missing',
        'The original file is not available on this device. Use Re-upload on the proposal row to restore it.');
      saveBlob(blob, name);
    } catch (error) {
      reportError('Download failed', 'The attachment could not be downloaded. Please try again.', error);
    }
  }
  window.v28DownloadAttachment = downloadStored;
  window.downloadInternalProposal = async id => {
    const record = (state.internalProposals || []).find(p => String(p.id) === String(id));
    if (!record) return reportError('Proposal not found', 'Refresh the proposal list and try again.');
    await downloadStored(record.id, record.fileName);
  };

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function zipBlob(entries) {
    if (!entries.length) throw new Error('No files to archive');
    if (entries.length > 65535) throw new Error('Too many files for one archive');
    const encoder = new TextEncoder();
    const locals = [], central = [];
    let offset = 0, centralBytes = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      const name = encoder.encode(filename(entry.name));
      if (bytes.byteLength > 0xffffffff || name.length > 65535) throw new Error('An attachment is too large for the ZIP format');
      const checksum = crc32(bytes);
      const local = new Uint8Array(30 + name.length);
      let v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true);
      v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, dosTime, true); v.setUint16(12, dosDate, true);
      v.setUint32(14, checksum, true); v.setUint32(18, bytes.length, true);
      v.setUint32(22, bytes.length, true); v.setUint16(26, name.length, true);
      local.set(name, 30);
      locals.push(local, bytes);
      const header = new Uint8Array(46 + name.length);
      v = new DataView(header.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true);
      v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true); v.setUint16(12, dosTime, true);
      v.setUint16(14, dosDate, true); v.setUint32(16, checksum, true);
      v.setUint32(20, bytes.length, true); v.setUint32(24, bytes.length, true);
      v.setUint16(28, name.length, true); v.setUint32(42, offset, true);
      header.set(name, 46);
      central.push(header); centralBytes += header.length;
      offset += local.length + bytes.length;
    }
    const end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
    view.setUint32(12, centralBytes, true); view.setUint32(16, offset, true);
    return new Blob([...locals, ...central, end], { type: 'application/zip' });
  }
  async function downloadGroup(rows, title) {
    if (!rows.length) return reportError('Nothing selected', 'Select at least one file to download.');
    try {
      const ready = [], missing = [];
      for (const row of rows) {
        const blob = await readBlob(row.id);
        if (!blob) missing.push(row.name);
        else ready.push({ name: String(ready.length + 1).padStart(2, '0') + '_' + safePart(row.name), blob });
      }
      if (!ready.length) return reportError('Original files missing',
        'No selected files are available on this device. Use Re-upload to restore older proposal documents.');
      if (ready.length === 1) saveBlob(ready[0].blob, rows.find(r => !missing.includes(r.name))?.name || ready[0].name);
      else saveBlob(await zipBlob(ready), title + '.zip');
      if (missing.length) notify('Some attachments unavailable', missing.length + ' file(s) could not be included. Re-upload those files to restore them.');
    } catch (error) {
      reportError('Bulk download failed', 'The selected file package could not be created.', error);
    }
  }
  function selectedProposals() {
    return [...document.querySelectorAll('#proposalTableBody tr[data-proposal-id]')]
      .filter(row => row.querySelector('.proposal-row-check:checked'))
      .map(row => (state.internalProposals || []).find(p => String(p.id) === row.dataset.proposalId))
      .filter(Boolean);
  }
  async function downloadProposals() {
    const selected = selectedProposals();
    if (!selected.length) return reportError('Select proposals', 'Tick one or more proposal rows first.');
    await downloadGroup(selected.map(p => ({ id: p.id, name: p.fileName })), 'YardLine_Internal_Proposals_' + todayIso());
  }
  function replaceBulkButton() {
    const old = document.getElementById('proposalDownloadSelected');
    if (!old) return;
    const fresh = old.cloneNode(true);
    old.replaceWith(fresh);
    fresh.addEventListener('click', downloadProposals);
  }
  window.v28DownloadSelectedFiles = async type => {
    const table = document.querySelector(type === 'employee' ? '.employee-table' : '.vehicle-table');
    const ids = [...(table?.querySelectorAll('tbody tr') || [])]
      .filter(row => row.querySelector('.master-row-check input:checked'))
      .map(row => row.dataset.masterId).filter(Boolean);
    if (!ids.length) return reportError('Select records', 'Select one or more ' + type + ' records first.');
    const rows = [];
    for (const id of ids) {
      const record = (type === 'employee' ? state.employees : state.vehicles).find(r => String(r.id) === String(id));
      if (!record) continue;
      const attachments = type === 'employee' ? record.certificates || [] : record.documents || [];
      for (const a of attachments) if (a.fileName) rows.push({ id: a.id, name: safePart(id) + '_' + a.fileName });
    }
    if (!rows.length) return reportError('No files', 'The selected records have no attached files.');
    await downloadGroup(rows, 'YardLine_' + type + '_Files_' + todayIso());
  };
  window.v28DownloadRecordFiles = async (type, id) => {
    const record = (type === 'employee' ? state.employees : state.vehicles).find(r => String(r.id) === String(id));
    if (!record) return reportError('Record unavailable', 'This record no longer exists.');
    const attachments = type === 'employee' ? record.certificates || [] : record.documents || [];
    const rows = attachments.filter(a => a.fileName).map(a => ({ id: a.id, name: a.fileName }));
    if (!rows.length) return reportError('No files', 'There are no uploaded files attached to this record.');
    await downloadGroup(rows, 'YardLine_' + type + '_' + safePart(id));
  };

  async function storeProposal(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const files = [...document.getElementById('proposalFiles').files];
    if (!files.length) return reportError('Files required', 'Select at least one proposal file.');
    const title = document.getElementById('proposalTitle').value.trim();
    if (!title) return reportError('Title required', 'Enter a proposal title.');
    const reference = document.getElementById('proposalReference').value.trim();
    const customer = document.getElementById('proposalCustomer').value || '-';
    const status = document.getElementById('proposalStatus').value;
    const notes = document.getElementById('proposalNotes').value.trim();
    const saved = [], failed = [];
    for (const file of files) {
      const id = uid('PROP');
      try {
        await persistBlob(id, file);
        saved.push({ id, title: files.length > 1 ? title + ' - ' + file.name.replace(/\.[^.]+$/, '') : title,
          reference, customer, status, notes, fileName: file.name, createdDate: todayIso() });
      } catch (error) {
        console.error('[Yard Line proposal upload]', file.name, error);
        failed.push(file.name);
      }
    }
    if (saved.length) {
      state.internalProposals.unshift(...saved);
      const metadataSaved = saveState();
      renderInternalProposals();
      if (metadataSaved) form.reset();
      if (!metadataSaved) return reportError('Browser storage full', 'Files were stored, but proposal metadata could not be saved. Export your records and free browser storage.');
      notify('Proposal files saved', saved.length + ' file(s) stored and ready to download.');
    }
    if (failed.length) reportError('Some uploads failed', failed.length + ' file(s) could not be stored. Check browser storage permissions and space.');
  }
  function replaceProposalForm() {
    const old = document.getElementById('internalProposalForm');
    if (!old) return;
    const fresh = old.cloneNode(true);
    old.replaceWith(fresh);
    fresh.addEventListener('submit', storeProposal);
  }
  window.v29ReuploadProposal = id => {
    const record = (state.internalProposals || []).find(p => String(p.id) === String(id));
    if (!record) return reportError('Proposal not found', 'Refresh the page and try again.');
    const chooser = document.createElement('input');
    chooser.type = 'file'; chooser.accept = fileTypes; chooser.style.display = 'none';
    chooser.addEventListener('change', async () => {
      const file = chooser.files?.[0];
      if (!file) return chooser.remove();
      try {
        await persistBlob(record.id, file);
        record.fileName = file.name;
        if (!saveState()) throw new Error('Could not save proposal metadata');
        renderInternalProposals();
        notify('Proposal file restored', file.name + ' is ready for download on this device.');
      } catch (error) {
        reportError('Re-upload failed', 'The replacement file could not be saved.', error);
      } finally { chooser.remove(); }
    });
    chooser.addEventListener('cancel', () => chooser.remove());
    document.body.appendChild(chooser);
    chooser.click();
  };
  const originalRenderProposals = window.renderInternalProposals;
  if (typeof originalRenderProposals === 'function') {
    window.renderInternalProposals = function () {
      originalRenderProposals.apply(this, arguments);
      const rows = [...document.querySelectorAll('#proposalTableBody tr[data-proposal-id]')];
      for (const row of rows) {
        const id = row.dataset.proposalId;
        const actions = row.querySelector('.row-action-group');
        if (!actions || actions.querySelector('.v29-reupload')) continue;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'row-action v29-reupload';
        button.textContent = 'Re-upload';
        button.title = 'Attach or replace the original file for this proposal';
        button.addEventListener('click', () => window.v29ReuploadProposal(id));
        const deleteButton = actions.querySelector('.danger-row');
        actions.insertBefore(button, deleteButton);
      }
    };
  }
  replaceProposalForm();
  replaceBulkButton();
  window.renderInternalProposals?.();
  console.info('Yard Line v29 - proposal download fix active');
})();
