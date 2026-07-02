/* ── NRO Patcher ───────────────────────────────────────────────
   Parses & rebuilds Nintendo Switch homebrew .nro files.
   All binary work happens in the browser — nothing is uploaded.
   ──────────────────────────────────────────────────────────── */

// ── DOM refs ──
const dropZone   = document.getElementById('drop-zone');
const fileInput  = document.getElementById('file-input');
const fileInfo   = document.getElementById('file-info');
const fileName   = document.getElementById('file-name');
const fileSize   = document.getElementById('file-size');
const btnReset   = document.getElementById('btn-reset');
const uploadErr  = document.getElementById('upload-error');

const editSec    = document.getElementById('edit-section');
const iconPrev   = document.getElementById('icon-preview');
const iconPH     = document.getElementById('icon-placeholder');
const iconInput  = document.getElementById('icon-input');
const btnResetIcon = document.getElementById('btn-reset-icon');
const appName    = document.getElementById('app-name');
const appAuthor  = document.getElementById('app-author');
const appVersion = document.getElementById('app-version');
const editErr    = document.getElementById('edit-error');

const dlSec      = document.getElementById('download-section');
const btnDl      = document.getElementById('btn-download');
const patchSum   = document.getElementById('patch-summary');

// ── State ──
let pristineNRO    = null;   // Uint8Array of the original file (never mutated)
let currentNRO     = null;   // Uint8Array of the current (possibly patched) file
let parsed         = null;   // result of parseNRO() on currentNRO
let newIconBytes   = null;   // JPEG bytes for replacement icon (null = keep current)
let changesApplied = false;

/* ──────────────────────────────────────────────────────────────
   NRO BINARY PARSER
   ────────────────────────────────────────────────────────────── */

const NRO0_MAGIC_LE = 0x304F524E; // "NRO0" little-endian
const ASET_MAGIC_LE = 0x54455341; // "ASET" little-endian

// NACP string field sizes (homebrew convention)
const NACP_NAME_SZ    = 0x200;
const NACP_AUTHOR_SZ  = 0x100;
const NACP_VERSION_SZ = 0x10;

/**
 * Find first occurrence of 4-byte LE magic in buffer, from startIdx.
 * Returns offset or -1.
 */
function findMagic(buf, magicLE, startIdx = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = startIdx; i <= buf.length - 4; i++) {
    if (dv.getUint32(i, true) === magicLE) return i;
  }
  return -1;
}

/**
 * Read a null-terminated (or max-length) UTF-8 string from buf at offset.
 */
function readCString(buf, offset, maxLen) {
  const end = Math.min(offset + maxLen, buf.length);
  let term = end;
  for (let i = offset; i < end; i++) {
    if (buf[i] === 0) { term = i; break; }
  }
  return new TextDecoder('utf-8').decode(buf.subarray(offset, term));
}

/**
 * Parse the NRO header. Returns object with segment offsets & sizes.
 * `nro0off` = offset in file where "NRO0" magic was found.
 */
function parseNROHeader(buf, nro0off) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The header fields start at nro0off. Standard header layout:
  // +0x00  magic "NRO0"  (4)
  // +0x04  version       (4)
  // +0x08  nro_size      (4)
  // +0x0C  flags         (4)
  // +0x10  text_offset   (4)
  // +0x14  text_size     (4)
  // +0x18  ro_offset     (4)
  // +0x1C  ro_size       (4)
  // +0x20  data_offset   (4)
  // +0x24  data_size     (4)
  // +0x28  bss_size      (4)
  // +0x2C  reserved      (4)
  // +0x30  build_id      (32)
  // +0x50  ... more fields vary by version

  const h = nro0off; // header base
  return {
    magicOff:   h,
    version:    dv.getUint32(h + 0x04, true),
    nroSize:    dv.getUint32(h + 0x08, true),
    flags:      dv.getUint32(h + 0x0C, true),
    textOff:    dv.getUint32(h + 0x10, true),
    textSize:   dv.getUint32(h + 0x14, true),
    roOff:      dv.getUint32(h + 0x18, true),
    roSize:     dv.getUint32(h + 0x1C, true),
    dataOff:    dv.getUint32(h + 0x20, true),
    dataSize:   dv.getUint32(h + 0x24, true),
    bssSize:    dv.getUint32(h + 0x28, true),
  };
}

/**
 * Parse the ASET (asset) header at `aoff`.
 * Handles both standard (nacp at +0x10) and extended (nacp at +0x18) layouts.
 */
function parseASET(buf, aoff) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const iconRel  = dv.getUint32(aoff + 0x08, true);
  let   iconSize = dv.getUint32(aoff + 0x0C, true);
  const nacpRelA = dv.getUint32(aoff + 0x10, true);  // standard location
  const nacpSzA  = dv.getUint32(aoff + 0x14, true);
  const nacpRelB = dv.getUint32(aoff + 0x18, true);  // extended location
  const nacpSzB  = dv.getUint32(aoff + 0x1C, true);

  // ── Icon: detect JPEG size if header says 0 ──
  if (iconSize === 0 && iconRel > 0) {
    const iconAbs = aoff + iconRel;
    // JPEG starts with FF D8, ends with FF D9
    if (iconAbs + 2 < buf.length && buf[iconAbs] === 0xFF && buf[iconAbs + 1] === 0xD8) {
      for (let k = iconAbs + 2; k < Math.min(iconAbs + 500000, buf.length) - 1; k++) {
        if (buf[k] === 0xFF && buf[k + 1] === 0xD9) {
          iconSize = k + 2 - iconAbs;
          break;
        }
      }
    }
  }

  // ── NACP: pick the candidate that looks like readable text ──
  let nacpRel = nacpRelA;
  let nacpSize = nacpSzA;
  if (nacpSize === 0 && nacpRelB > 0) {
    // Check if candidate B looks more like NACP text than candidate A
    const aAbs = aoff + nacpRelA;
    const bAbs = aoff + nacpRelB;
    if (startsWithReadableASCII(buf, bAbs) && !startsWithReadableASCII(buf, aAbs)) {
      nacpRel = nacpRelB;
      nacpSize = nacpSzB;
    }
  }

  // NACP size is often 0 in real NROs — use standard 0x310 when missing
  if (nacpSize === 0) nacpSize = 0x310;

  const iconAbs = aoff + iconRel;
  const nacpAbs = aoff + nacpRel;
  // Remember which nacp offset field we used so patching updates the right one
  const nacpSlot = (nacpRel === nacpRelB && nacpRelB !== nacpRelA) ? 'B' : 'A';
  return {
    asetOff:  aoff,
    iconOff:  iconAbs,
    iconSize: iconSize,
    iconRel:  iconRel,     // for patching
    nacpOff:  nacpAbs,
    nacpSize: nacpSize,
    nacpRel:  nacpRel,     // for patching
    nacpSlot: nacpSlot,    // 'A' (+0x10) or 'B' (+0x18)
    tailOff:  Math.max(iconAbs + iconSize, nacpAbs + nacpSize),
  };
}

/** Check if `offset` in `buf` starts with mostly printable ASCII text. */
function startsWithReadableASCII(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) return false;
  let printable = 0;
  let examined = 0;
  const checkLen = Math.min(32, buf.length - offset);
  for (let i = 0; i < checkLen; i++) {
    const b = buf[offset + i];
    examined = i + 1;
    if (b >= 32 && b < 127) printable++;
    if (b === 0 && i > 0) break; // null terminator
  }
  if (examined < 2) return false;
  return printable >= 2 && printable / examined > 0.6;
}

/**
 * Parse metadata from NACP.
 */
function parseNACP(buf, nacpOff) {
  return {
    name:    readCString(buf, nacpOff, NACP_NAME_SZ),
    author:  readCString(buf, nacpOff + NACP_NAME_SZ, NACP_AUTHOR_SZ),
    version: readCString(buf, nacpOff + NACP_NAME_SZ + NACP_AUTHOR_SZ, NACP_VERSION_SZ),
  };
}

/**
 * Full parse of an NRO file.
 */
function parseNRO(buf) {
  // Find NRO0 magic — look in first 0x200 bytes
  const nro0off = findMagic(buf, NRO0_MAGIC_LE, 0);
  if (nro0off === -1) {
    // also try searching deeper for non-standard layouts
    const nro0off2 = findMagic(buf, NRO0_MAGIC_LE, 0x200);
    if (nro0off2 === -1) throw new Error('Not a valid NRO file — "NRO0" magic not found.');
    // If found deeper, that's unusual but we can work with it
    throw new Error('NRO0 magic found at unexpected offset. This NRO format is not supported.');
  }

  const header = parseNROHeader(buf, nro0off);

  // Find ASET — search the whole file
  const asetOff = findMagic(buf, ASET_MAGIC_LE, 0);
  if (asetOff === -1) throw new Error('No ASET section found — this NRO has no embedded icon/metadata.');

  const aset = parseASET(buf, asetOff);
  const meta = parseNACP(buf, aset.nacpOff);

  // Determine which segment contains ASET
  // ASET can be in .rodata, .data, or at end of file (uncommon)
  let asetSegment = null;
  const segs = [
    { name: 'text',   off: header.textOff,  size: header.textSize },
    { name: 'rodata', off: header.roOff,    size: header.roSize },
    { name: 'data',   off: header.dataOff,  size: header.dataSize },
  ];
  for (const seg of segs) {
    if (seg.size === 0) continue;
    if (asetOff >= seg.off && asetOff < seg.off + seg.size) {
      asetSegment = seg;
      break;
    }
  }
  // If ASET isn't inside any known segment, it might be in a trailing
  // section not tracked by the header. We treat it as standalone.

  return { header, aset, meta, asetSegment };
}

/* ──────────────────────────────────────────────────────────────
   NRO PATCHER
   ────────────────────────────────────────────────────────────── */

/**
 * Rebuild the NRO with patched icon and/or metadata.
 * `changes` = { icon: Uint8Array|null, name: string|null, author: string|null, version: string|null }
 * Fields set to null/undefined keep the original value.
 */
function patchNRO(orig, parsed, changes) {
  const { header, aset, meta, asetSegment } = parsed;
  const dv = new DataView(orig.buffer, orig.byteOffset, orig.byteLength);

  // ── Step 1: decide new icon size ──
  const oldIconSize = aset.iconSize;
  const newIcon     = changes.icon;
  const iconDiff    = newIcon ? (newIcon.length - oldIconSize) : 0;

  // ── Step 2: compute layout ──
  // The ASET layout:
  //   [ASET header 0x18 bytes] [icon data] [NACP data]
  // The icon and NACP offsets in the ASET header are relative to ASET start.
  // After icon, NACP follows. If icon grows, NACP shifts forward.
  // If icon shrinks, NACP shifts backward.

  const oldNacpRelOff = aset.nacpOff - aset.asetOff; // original NACP relative offset
  const newNacpRelOff = oldNacpRelOff + iconDiff;

  // ── Step 3: build the new file ──
  // We'll split the file into slices and reassemble.
  // Slices: [before ASET] [ASET header] [icon] [NACP] [after ASET tail] [after ASET segment]

  const asetHdrEnd = aset.asetOff + 0x18; // ASET header is 0x18 bytes
  const iconStart  = aset.iconOff;         // absolute
  const iconEnd    = iconStart + oldIconSize;
  const nacpStart  = aset.nacpOff;
  const nacpEnd    = nacpStart + aset.nacpSize;
  const tailStart  = aset.tailOff;         // end of ASET data

  // Build slices
  const slices = [];

  // 1. Everything before ASET header
  slices.push(orig.subarray(0, aset.asetOff));

  // 2. ASET header itself (0x18 bytes) — MUST be preserved then patched in Step 4
  slices.push(orig.subarray(aset.asetOff, asetHdrEnd));

  // 3. Everything between ASET header end and icon start (usually nothing)
  if (iconStart > asetHdrEnd) {
    slices.push(orig.subarray(asetHdrEnd, iconStart));
  }

  // 4. Icon data (new or original)
  if (newIcon) {
    slices.push(newIcon);
  } else {
    slices.push(orig.subarray(iconStart, iconEnd));
  }

  // 5. Everything between icon end and NACP start
  if (nacpStart > iconEnd) {
    slices.push(orig.subarray(iconEnd, nacpStart));
  }

  // 6. NACP data (with patched name/author/version)
  const nacpPatched = patchNACP(orig, aset.nacpOff, aset.nacpSize, changes);
  slices.push(nacpPatched);

  // 7. After NACP to tail end (usually nothing)
  if (tailStart > nacpEnd) {
    slices.push(orig.subarray(nacpEnd, tailStart));
  }

  // 8. After ASET tail to end of file
  if (tailStart < orig.length) {
    slices.push(orig.subarray(tailStart, orig.length));
  }

  // Concatenate all slices
  const totalLen = slices.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const s of slices) {
    out.set(s, pos);
    pos += s.length;
  }

  // ── Step 4: patch ASET header in output ──
  const outDV = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const newIconSz = newIcon ? newIcon.length : oldIconSize;
  outDV.setUint32(aset.asetOff + 0x0C, newIconSz, true);          // icon size
  outDV.setUint32(aset.asetOff + 0x10, newNacpRelOff, true);       // nacp offset slot A
  outDV.setUint32(aset.asetOff + 0x14, aset.nacpSize, true);       // nacp size slot A
  outDV.setUint32(aset.asetOff + 0x18, newNacpRelOff, true);       // nacp offset slot B (extended)
  outDV.setUint32(aset.asetOff + 0x1C, aset.nacpSize, true);       // nacp size slot B

  // ── Step 5: patch NRO header (segment sizes + offsets + total size) ──
  if (iconDiff !== 0) {
    const magicOff = header.magicOff;
    const segFields = [
      { name: 'text',   offField: 0x10, sizeField: 0x14 },
      { name: 'rodata', offField: 0x18, sizeField: 0x1C },
      { name: 'data',   offField: 0x20, sizeField: 0x24 },
    ];

    for (const sf of segFields) {
      const segOff = dv.getUint32(magicOff + sf.offField, true);
      if (segOff === 0) continue;

      // Update size of the segment that contains ASET
      if (asetSegment && sf.name === asetSegment.name) {
        outDV.setUint32(magicOff + sf.sizeField, asetSegment.size + iconDiff, true);
      }

      // Shift any segment whose data is physically after the ASET tail
      if (segOff > aset.tailOff) {
        outDV.setUint32(magicOff + sf.offField, segOff + iconDiff, true);
      }
    }

    // Always update NRO total file size when icon size changes
    outDV.setUint32(magicOff + 0x08, totalLen, true);
  }

  return out;
}

/**
 * Create a patched NACP block.
 */
function patchNACP(orig, nacpOff, nacpSize, changes) {
  const out = new Uint8Array(nacpSize);
  // Copy original
  out.set(new Uint8Array(orig.buffer, orig.byteOffset + nacpOff, nacpSize));

  const encoder = new TextEncoder();

  function writeField(offset, maxLen, value) {
    if (value === null || value === undefined) return;
    const bytes = encoder.encode(value);
    const writeLen = Math.min(bytes.length, maxLen - 1); // leave room for null
    out.set(bytes.subarray(0, writeLen), offset);
    // Zero out the rest
    out.fill(0, offset + writeLen, offset + maxLen);
  }

  writeField(0x000, NACP_NAME_SZ, changes.name);
  writeField(NACP_NAME_SZ, NACP_AUTHOR_SZ, changes.author);
  writeField(NACP_NAME_SZ + NACP_AUTHOR_SZ, NACP_VERSION_SZ, changes.version);

  return out;
}

/* ──────────────────────────────────────────────────────────────
   ICON HELPERS
   ────────────────────────────────────────────────────────────── */

/**
 * Convert any image file (PNG, JPEG, WebP, etc.) to a JPEG Uint8Array
 * at a reasonable size for an NRO icon (256×256 max).
 */
function imageFileToJPEG(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Scale to max 256×256 keeping aspect ratio
        const MAX = 256;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('Canvas toBlob failed.'));
          blob.arrayBuffer().then(ab => resolve(new Uint8Array(ab)));
        }, 'image/jpeg', 0.9);
      };
      img.onerror = () => reject(new Error('Failed to load image.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Create a blob URL from Uint8Array JPEG data for <img> display.
 */
function jpegToObjectURL(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

/* ──────────────────────────────────────────────────────────────
   UI LOGIC
   ────────────────────────────────────────────────────────────── */

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ── Load NRO ──
async function loadNRO(file) {
  hideError(uploadErr);
  hideError(editErr);

  if (!file.name.toLowerCase().endsWith('.nro')) {
    showError(uploadErr, 'Please select a .nro file.');
    return;
  }

  try {
    const ab = await file.arrayBuffer();
    const buf = new Uint8Array(ab);

    pristineNRO = buf;
    currentNRO = buf;
    parsed = parseNRO(buf);

    // Show file info
    fileName.textContent = file.name;
    fileSize.textContent = formatSize(file.size);
    fileInfo.classList.remove('hidden');
    dropZone.classList.add('hidden');

    // Populate edit fields
    populateEditUI();
    editSec.classList.remove('hidden');
    dlSec.classList.remove('hidden');
    updateDownloadInfo();

    // Reset icon state
    newIconBytes = null;
    btnResetIcon.classList.add('hidden');
    changesApplied = false;

  } catch (err) {
    showError(uploadErr, err.message);
    console.error('NRO parse error:', err);
  }
}

function populateEditUI() {
  const { aset, meta } = parsed;

  refreshIconPreview();

  // Text fields
  appName.value = meta.name;
  appAuthor.value = meta.author;
  appVersion.value = meta.version;
}

/** Update just the icon <img> without touching text fields. */
function refreshIconPreview() {
  const { aset } = parsed;
  if (aset.iconSize > 0 && aset.iconOff > 0) {
    const jpeg = currentNRO.subarray(aset.iconOff, aset.iconOff + aset.iconSize);
    const url = jpegToObjectURL(jpeg);
    if (iconPrev.src) URL.revokeObjectURL(iconPrev.src);
    iconPrev.classList.remove('broken', 'hidden');
    iconPrev.style.display = '';
    iconPrev.src = url;
    iconPH.classList.add('hidden');
  } else {
    iconPrev.classList.add('hidden');
    iconPH.classList.remove('hidden');
  }
}

// ── Apply changes & rebuild ──
function applyChanges() {
  if (!parsed) return;

  const changes = {
    icon:    newIconBytes,
    name:    appName.value !== parsed.meta.name    ? appName.value    : null,
    author:  appAuthor.value !== parsed.meta.author  ? appAuthor.value  : null,
    version: appVersion.value !== parsed.meta.version ? appVersion.value : null,
  };

  const hasChanges = changes.icon || changes.name || changes.author || changes.version;
  if (!hasChanges) return;

  try {
    const patched = patchNRO(currentNRO, parsed, changes);
    // Update currentNRO for subsequent patches so we can keep layering
    currentNRO = patched;
    // Re-parse to update offsets
    parsed = parseNRO(patched);
    newIconBytes = null;
    btnResetIcon.classList.add('hidden');

    // Update icon preview (but don't reset text fields the user is editing)
    refreshIconPreview();
    updateDownloadInfo();
    changesApplied = true;
  } catch (err) {
    showError(editErr, 'Failed to patch NRO: ' + err.message);
    console.error('Patch error:', err);
  }
}

// ── Download ──
function downloadPatched() {
  // Apply any pending text changes before download
  if (hasPendingTextChanges()) {
    applyChanges();
  }

  if (!currentNRO) return;

  const origName = parsed ? parsed.meta.name : 'homebrew';
  const safeName = origName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'patched';
  const dlName = safeName + '.nro';

  const blob = new Blob([currentNRO], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = dlName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function hasPendingTextChanges() {
  if (!parsed) return false;
  return (
    appName.value !== parsed.meta.name ||
    appAuthor.value !== parsed.meta.author ||
    appVersion.value !== parsed.meta.version
  );
}

function updateDownloadInfo() {
  const parts = [];
  if (parsed) {
    parts.push(`<span>${escapeHTML(parsed.meta.name || '(no name)')}</span>`);
    if (parsed.meta.version) parts.push(`<span>v${escapeHTML(parsed.meta.version)}</span>`);
    if (parsed.meta.author) parts.push(`<span>by ${escapeHTML(parsed.meta.author)}</span>`);
    if (parsed.aset.iconSize > 0) {
      parts.push(`<span>icon: ${parsed.aset.iconSize}B JPEG</span>`);
    }
  }
  patchSum.innerHTML = parts.join(' ');
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Reset ──
function resetAll() {
  pristineNRO = null;
  currentNRO = null;
  parsed = null;
  newIconBytes = null;
  changesApplied = false;

  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  editSec.classList.add('hidden');
  dlSec.classList.add('hidden');
  hideError(uploadErr);
  hideError(editErr);
  fileInput.value = '';
  iconInput.value = '';

  if (iconPrev.src) {
    URL.revokeObjectURL(iconPrev.src);
    iconPrev.src = '';
    iconPrev.classList.add('hidden');
    iconPrev.classList.remove('broken');
    iconPrev.style.display = '';
  }
  iconPrev.classList.add('hidden');
  iconPH.classList.add('hidden');
  btnResetIcon.classList.add('hidden');
  appName.value = '';
  appAuthor.value = '';
  appVersion.value = '';
  patchSum.innerHTML = '';
}

/* ── Event Listeners ── */

// Drag & drop
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadNRO(file);
});
dropZone.addEventListener('click', () => fileInput.click());

// File input
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) loadNRO(file);
});

// Reset
btnReset.addEventListener('click', resetAll);

// Icon upload
iconInput.addEventListener('change', async () => {
  const file = iconInput.files[0];
  if (!file) return;
  hideError(editErr);
  try {
    newIconBytes = await imageFileToJPEG(file);
    // Show preview
    const url = jpegToObjectURL(newIconBytes);
    if (iconPrev.src) URL.revokeObjectURL(iconPrev.src);
    iconPrev.src = url;
    iconPrev.classList.remove('hidden');
    iconPH.classList.add('hidden');
    btnResetIcon.classList.remove('hidden');
    applyChanges();
  } catch (err) {
    showError(editErr, 'Failed to process icon: ' + err.message);
  }
});

// Reset icon
btnResetIcon.addEventListener('click', () => {
  btnResetIcon.classList.add('hidden');
  // Revert to the original icon from pristine NRO
  const pristineParsed = parseNRO(pristineNRO);
  if (pristineParsed.aset.iconSize > 0 && pristineParsed.aset.iconOff > 0) {
    newIconBytes = pristineNRO.subarray(
      pristineParsed.aset.iconOff,
      pristineParsed.aset.iconOff + pristineParsed.aset.iconSize
    );
    const url = jpegToObjectURL(newIconBytes);
    if (iconPrev.src) URL.revokeObjectURL(iconPrev.src);
    iconPrev.src = url;
    iconPrev.classList.remove('hidden');
    iconPH.classList.add('hidden');
  } else {
    newIconBytes = new Uint8Array(0); // empty icon
    iconPrev.classList.add('hidden');
    iconPH.classList.remove('hidden');
  }
  applyChanges();
});

// Text field changes — apply on input
[appName, appAuthor, appVersion].forEach(el => {
  el.addEventListener('input', () => {
    hideError(editErr);
    applyChanges();
  });
});

// Download button
btnDl.addEventListener('click', downloadPatched);

// Keyboard shortcut: Ctrl+S / Cmd+S to download
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && parsed) {
    e.preventDefault();
    downloadPatched();
  }
});

