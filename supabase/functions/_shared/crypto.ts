const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Invalid base64 token data");
  }

  if (bytesToBase64(Uint8Array.from(binary, (character) => character.charCodeAt(0))) !== value) {
    throw new Error("Invalid base64 token data");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeStoredEnvelope(value: string): Uint8Array {
  if (!value.startsWith("\\x")) return base64ToBytes(value);

  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Invalid encrypted token storage");
  }

  const storedBytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    storedBytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  // PostgREST returns bytea as hex. Support both raw-envelope bytea and
  // base64 text previously inserted into a bytea column.
  if (storedBytes[0] === ENVELOPE_VERSION) return storedBytes;
  try {
    return base64ToBytes(new TextDecoder("utf-8", { fatal: true }).decode(storedBytes));
  } catch {
    throw new Error("Invalid encrypted token storage");
  }
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(encodedKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  }

  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToken(plainText: string, key: string): Promise<string> {
  const encryptionKey = await importEncryptionKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainText);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    encoded,
  ));

  const envelope = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(iv, 1);
  envelope.set(ciphertext, 1 + IV_LENGTH);
  return bytesToBase64(envelope);
}

export async function decryptToken(cipherText: string, key: string): Promise<string> {
  const envelope = decodeStoredEnvelope(cipherText);
  if (envelope.byteLength < 1 + IV_LENGTH + GCM_TAG_LENGTH || envelope[0] !== ENVELOPE_VERSION) {
    throw new Error("Unsupported or invalid encrypted token envelope");
  }

  const encryptionKey = await importEncryptionKey(key);
  const iv = envelope.slice(1, 1 + IV_LENGTH);
  const ciphertext = envelope.slice(1 + IV_LENGTH);

  try {
    const plainText = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      encryptionKey,
      ciphertext,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plainText);
  } catch {
    throw new Error("Stored token could not be decrypted");
  }
}
