const NRO_MAGIC = 0x304f524e;
const ASET_MAGIC = 0x54455341;
const NRO_HEADER_OFFSET = 0x10;
const ASET_HEADER_SIZE = 0x38;
const NACP_MIN_SIZE = 0x3070;
const LANGUAGE_COUNT = 16;
const LANGUAGE_SIZE = 0x300;
const NAME_SIZE = 0x200;
const AUTHOR_SIZE = 0x100;
const VERSION_OFFSET = 0x3060;
const VERSION_SIZE = 0x10;

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

function fail(message) { throw new Error(message); }
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u64(dv, offset) {
  const value = dv.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('This NRO contains an unsupported 64-bit asset offset.');
  return Number(value);
}
function setU64(dv, offset, value) { dv.setBigUint64(offset, BigInt(value), true); }
function readString(bytes, offset, size) {
  let end = offset;
  const limit = offset + size;
  while (end < limit && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}
function utf8Length(value) { return encoder.encode(value).length; }

function validateSection(section, fileLength, asetOffset) {
  if (section.size === 0) return;
  if (section.offset < ASET_HEADER_SIZE) fail(`The ${section.name} asset overlaps the ASET header.`);
  if (asetOffset + section.offset + section.size > fileLength) fail(`The ${section.name} asset extends past the end of the file.`);
}

export function parseNRO(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < NRO_HEADER_OFFSET + 0x70) fail('This file is too small to be an NRO.');
  const dv = view(bytes);
  if (dv.getUint32(NRO_HEADER_OFFSET, true) !== NRO_MAGIC) fail('Not a valid NRO: the NRO0 header is missing.');
  const executableSize = dv.getUint32(NRO_HEADER_OFFSET + 8, true);
  if (executableSize < 0x80 || executableSize + ASET_HEADER_SIZE > bytes.length) fail('The NRO executable size is invalid or it has no asset section.');
  if (dv.getUint32(executableSize, true) !== ASET_MAGIC) fail('This NRO has no embedded ASET icon/metadata section.');
  const asetVersion = dv.getUint32(executableSize + 4, true);
  if (asetVersion !== 0) fail(`Unsupported ASET version ${asetVersion}.`);

  const readSection = (name, fieldOffset) => ({
    name,
    offset: u64(dv, executableSize + fieldOffset),
    size: u64(dv, executableSize + fieldOffset + 8),
  });
  const icon = readSection('icon', 0x08);
  const nacp = readSection('NACP', 0x18);
  const romfs = readSection('RomFS', 0x28);
  [icon, nacp, romfs].forEach(section => validateSection(section, bytes.length, executableSize));
  if (nacp.size < NACP_MIN_SIZE) fail('The embedded NACP is missing or too small to edit safely.');

  const nacpStart = executableSize + nacp.offset;
  const languages = Array.from({ length: LANGUAGE_COUNT }, (_, index) => ({
    index,
    name: readString(bytes, nacpStart + index * LANGUAGE_SIZE, NAME_SIZE),
    author: readString(bytes, nacpStart + index * LANGUAGE_SIZE + NAME_SIZE, AUTHOR_SIZE),
  }));
  const primary = languages.find(entry => entry.name || entry.author) || languages[0];
  const metadata = {
    name: primary.name,
    author: primary.author,
    version: readString(bytes, nacpStart + VERSION_OFFSET, VERSION_SIZE),
  };
  return { bytes, executableSize, asetOffset: executableSize, asetVersion, icon, nacp, romfs, nacpStart, languages, primaryLanguage: primary.index, metadata };
}

function validateText(name, value, size) {
  if (typeof value !== 'string') fail(`${name} must be text.`);
  const length = utf8Length(value);
  if (length >= size) fail(`${name} is too long (${length} UTF-8 bytes; maximum ${size - 1}).`);
}
function writeString(bytes, offset, size, value) {
  const encoded = encoder.encode(value);
  bytes.fill(0, offset, offset + size);
  bytes.set(encoded, offset);
}

function replaceIcon(original, parsed, replacement) {
  if (replacement === undefined || replacement === null) return original.slice();
  const icon = replacement instanceof Uint8Array ? replacement : new Uint8Array(replacement);
  if (icon.length < 4 || icon[0] !== 0xff || icon[1] !== 0xd8 || icon[icon.length - 2] !== 0xff || icon[icon.length - 1] !== 0xd9) {
    fail('The replacement icon must be a complete JPEG image.');
  }

  const oldOffset = parsed.icon.size ? parsed.icon.offset : ASET_HEADER_SIZE;
  const oldSize = parsed.icon.size;
  const insertion = parsed.asetOffset + oldOffset;
  const delta = icon.length - oldSize;
  const output = new Uint8Array(original.length + delta);
  output.set(original.subarray(0, insertion), 0);
  output.set(icon, insertion);
  output.set(original.subarray(insertion + oldSize), insertion + icon.length);

  const dv = view(output);
  setU64(dv, parsed.asetOffset + 0x08, oldOffset);
  setU64(dv, parsed.asetOffset + 0x10, icon.length);
  for (const [section, field] of [[parsed.nacp, 0x18], [parsed.romfs, 0x28]]) {
    if (section.size && section.offset >= oldOffset + oldSize) setU64(dv, parsed.asetOffset + field, section.offset + delta);
  }
  return output;
}

export function patchNRO(input, changes = {}) {
  const original = input instanceof Uint8Array ? input : new Uint8Array(input);
  const parsed = parseNRO(original);
  if (changes.name !== undefined) validateText('App name', changes.name, NAME_SIZE);
  if (changes.author !== undefined) validateText('Author', changes.author, AUTHOR_SIZE);
  if (changes.version !== undefined) validateText('Version', changes.version, VERSION_SIZE);

  const output = replaceIcon(original, parsed, changes.icon);
  const updated = parseNRO(output);
  const languageTargets = updated.languages.filter(entry => entry.name || entry.author).map(entry => entry.index);
  if (languageTargets.length === 0) languageTargets.push(0);
  for (const index of languageTargets) {
    const base = updated.nacpStart + index * LANGUAGE_SIZE;
    if (changes.name !== undefined) writeString(output, base, NAME_SIZE, changes.name);
    if (changes.author !== undefined) writeString(output, base + NAME_SIZE, AUTHOR_SIZE, changes.author);
  }
  if (changes.version !== undefined) writeString(output, updated.nacpStart + VERSION_OFFSET, VERSION_SIZE, changes.version);
  return output;
}

export const limits = { name: NAME_SIZE - 1, author: AUTHOR_SIZE - 1, version: VERSION_SIZE - 1 };
export { utf8Length };
