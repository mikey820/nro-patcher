if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class {
    encode(value) {
      const binary = unescape(encodeURIComponent(value));
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
  };
  globalThis.TextDecoder = class {
    decode(bytes) {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      try { return decodeURIComponent(escape(binary)); } catch { return '\ufffd'; }
    }
  };
}

const { parseNRO, patchNRO, utf8Length } = await import('../nro.js');

const ASET = 0x200;
const HEADER = 0x38;
const ICON = Uint8Array.of(0xff, 0xd8, 1, 2, 3, 0xff, 0xd9);
const NACP_SIZE = 0x4000;
const ROMFS = Uint8Array.of(0x52, 0x4f, 0x4d, 0x46, 0x53, 7, 8, 9);
const enc = new TextEncoder();
const dec = new TextDecoder();

function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected, message) { assert(actual === expected, `${message}: got ${actual}, expected ${expected}`); }
function put64(dv, offset, value) { dv.setBigUint64(offset, BigInt(value), true); }
function text(bytes, offset, value) { bytes.set(enc.encode(value), offset); }
function fixture({ icon = true } = {}) {
  const iconBytes = icon ? ICON : new Uint8Array();
  const iconOffset = icon ? HEADER : 0;
  const nacpOffset = HEADER + iconBytes.length + 5;
  const romfsOffset = nacpOffset + NACP_SIZE + 3;
  const bytes = new Uint8Array(ASET + romfsOffset + ROMFS.length);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0x10, 0x304f524e, true);
  dv.setUint32(0x18, ASET, true);
  for (let i = 0; i < ASET; i++) bytes[i] ||= (i * 13) & 0xff;
  dv.setUint32(0x10, 0x304f524e, true);
  dv.setUint32(0x18, ASET, true);
  dv.setUint32(ASET, 0x54455341, true);
  put64(dv, ASET + 0x08, iconOffset); put64(dv, ASET + 0x10, iconBytes.length);
  put64(dv, ASET + 0x18, nacpOffset); put64(dv, ASET + 0x20, NACP_SIZE);
  put64(dv, ASET + 0x28, romfsOffset); put64(dv, ASET + 0x30, ROMFS.length);
  if (icon) bytes.set(iconBytes, ASET + iconOffset);
  const nacp = ASET + nacpOffset;
  text(bytes, nacp, 'Fixture App'); text(bytes, nacp + 0x200, 'Fixture Author');
  text(bytes, nacp + 0x300, 'French title'); text(bytes, nacp + 0x500, 'French author');
  text(bytes, nacp + 0x3060, '1.2.3');
  bytes.set(ROMFS, ASET + romfsOffset);
  return bytes;
}
function bytesEqual(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }

const original = fixture();
const parsed = parseNRO(original);
equal(parsed.metadata.name, 'Fixture App', 'reads name');
equal(parsed.metadata.author, 'Fixture Author', 'reads author');
equal(parsed.metadata.version, '1.2.3', 'reads display version at 0x3060');
equal(parsed.icon.size, ICON.length, 'reads 64-bit icon size');

const newIcon = Uint8Array.of(0xff, 0xd8, 9, 8, 7, 6, 5, 4, 3, 2, 0xff, 0xd9);
const patched = patchNRO(original, { name: 'New 🎮 Name', author: 'New Author', version: '2.0', icon: newIcon });
const after = parseNRO(patched);
equal(after.metadata.name, 'New 🎮 Name', 'patches UTF-8 name');
equal(after.metadata.author, 'New Author', 'patches author');
equal(after.metadata.version, '2.0', 'patches version');
equal(after.languages[1].name, 'New 🎮 Name', 'patches every populated language');
equal(after.icon.size, newIcon.length, 'patches icon size');
equal(after.nacp.offset, parsed.nacp.offset + newIcon.length - ICON.length, 'shifts NACP offset');
equal(after.romfs.offset, parsed.romfs.offset + newIcon.length - ICON.length, 'shifts RomFS offset');
assert(bytesEqual(patched.slice(0, ASET), original.slice(0, ASET)), 'executable bytes must remain unchanged');
assert(bytesEqual(patched.slice(after.asetOffset + after.icon.offset, after.asetOffset + after.icon.offset + newIcon.length), newIcon), 'new icon bytes preserved');
assert(bytesEqual(patched.slice(after.asetOffset + after.romfs.offset, after.asetOffset + after.romfs.offset + ROMFS.length), ROMFS), 'RomFS preserved');

const noIcon = fixture({ icon: false });
const iconAdded = parseNRO(patchNRO(noIcon, { icon: newIcon }));
equal(iconAdded.icon.offset, HEADER, 'adds missing icon after header');
equal(iconAdded.nacp.offset, parseNRO(noIcon).nacp.offset + newIcon.length, 'shifts NACP when adding icon');

let rejected = false;
try { patchNRO(original, { version: '1234567890123456' }); } catch (error) { rejected = /too long/.test(error.message); }
assert(rejected, 'rejects fields that do not fit instead of truncating');
equal(utf8Length('🎮'), 4, 'counts UTF-8 bytes');

print('PASS: NRO parser and patcher fixture suite');
