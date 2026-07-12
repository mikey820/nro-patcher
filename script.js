import { limits, parseNRO, patchNRO, utf8Length } from './nro.js';

const $ = id => document.getElementById(id);
const input = $('nro-input');
const dropZone = $('drop-zone');
const importPanel = $('import-panel');
const editorPanel = $('editor-panel');
const importError = $('import-error');
const editError = $('edit-error');
const iconInput = $('icon-input');
const iconPreview = $('icon-preview');
const iconEmpty = $('icon-empty');
const resetIcon = $('reset-icon');
const nameInput = $('app-name');
const authorInput = $('app-author');
const versionInput = $('app-version');
const downloadButton = $('download-button');

let source = null;
let sourceName = '';
let originalIcon = null;
let replacementIcon = undefined;
let previewUrl = null;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}
function showError(element, message) { element.textContent = message; element.hidden = false; }
function clearError(element) { element.textContent = ''; element.hidden = true; }
function setPreview(bytes) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (!bytes?.length) { iconPreview.hidden = true; iconEmpty.hidden = false; return; }
  previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  iconPreview.src = previewUrl;
  iconPreview.hidden = false;
  iconEmpty.hidden = true;
}
function updateCount(field, label, limit) {
  const count = utf8Length(field.value);
  $(label).textContent = `${count} / ${limit} bytes`;
  field.classList.toggle('invalid', count > limit);
  return count <= limit;
}
function fieldsValid() {
  return updateCount(nameInput, 'name-count', limits.name)
    & updateCount(authorInput, 'author-count', limits.author)
    & updateCount(versionInput, 'version-count', limits.version);
}
function currentChanges() {
  return { name: nameInput.value, author: authorInput.value, version: versionInput.value, icon: replacementIcon };
}
function updateOutput() {
  clearError(editError);
  if (!source || !fieldsValid()) { downloadButton.disabled = true; return; }
  try {
    const output = patchNRO(source, currentChanges());
    $('output-size').textContent = `${formatSize(output.length)} · rebuilt locally`;
    downloadButton.disabled = false;
  } catch (error) {
    downloadButton.disabled = true;
    showError(editError, error.message);
  }
}
async function loadNRO(file) {
  clearError(importError);
  if (!file || !file.name.toLowerCase().endsWith('.nro')) return showError(importError, 'Choose a file ending in .nro.');
  if (file.size > 512 * 1024 * 1024) return showError(importError, 'This NRO is larger than the 512 MB browser safety limit.');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseNRO(bytes);
    source = bytes;
    sourceName = file.name;
    replacementIcon = undefined;
    originalIcon = parsed.icon.size ? bytes.slice(parsed.asetOffset + parsed.icon.offset, parsed.asetOffset + parsed.icon.offset + parsed.icon.size) : null;
    $('file-name').textContent = file.name;
    $('file-size').textContent = formatSize(file.size);
    nameInput.value = parsed.metadata.name;
    authorInput.value = parsed.metadata.author;
    versionInput.value = parsed.metadata.version;
    setPreview(originalIcon);
    resetIcon.hidden = true;
    importPanel.hidden = true;
    editorPanel.hidden = false;
    document.querySelectorAll('.rail-step').forEach(step => step.classList.add('active'));
    updateOutput();
  } catch (error) { showError(importError, error.message); }
}
async function imageToJpeg(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('The image is larger than the 20 MB safety limit.');
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000'; context.fillRect(0, 0, 256, 256);
  const scale = Math.max(256 / bitmap.width, 256 / bitmap.height);
  const width = bitmap.width * scale, height = bitmap.height * scale;
  context.drawImage(bitmap, (256 - width) / 2, (256 - height) / 2, width, height);
  bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
  if (!blob) throw new Error('Your browser could not convert this image to JPEG.');
  return new Uint8Array(await blob.arrayBuffer());
}
function download() {
  clearError(editError);
  try {
    const output = patchNRO(source, currentChanges());
    const blobUrl = URL.createObjectURL(new Blob([output], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `${sourceName.replace(/\.nro$/i, '')}-patched.nro`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (error) { showError(editError, error.message); }
}

['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', event => loadNRO(event.dataTransfer.files[0]));
dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') input.click(); });
input.addEventListener('change', () => loadNRO(input.files[0]));
$('replace-nro').addEventListener('click', () => input.click());
[nameInput, authorInput, versionInput].forEach(field => field.addEventListener('input', updateOutput));
iconInput.addEventListener('change', async () => {
  clearError(editError);
  try { replacementIcon = await imageToJpeg(iconInput.files[0]); setPreview(replacementIcon); resetIcon.hidden = false; updateOutput(); }
  catch (error) { showError(editError, error.message); }
});
resetIcon.addEventListener('click', () => { replacementIcon = undefined; setPreview(originalIcon); resetIcon.hidden = true; iconInput.value = ''; updateOutput(); });
downloadButton.addEventListener('click', download);
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && source) { event.preventDefault(); download(); } });
document.documentElement.dataset.appReady = 'true';
