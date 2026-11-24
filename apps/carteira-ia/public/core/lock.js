// Senha de acesso e modo "ocultar valores".
//
// A senha nunca é guardada: guardamos só um hash PBKDF2 (SHA-256, com sal aleatório). Serve para
// impedir que alguém que abra o app no seu computador ou no seu link veja os valores — não é
// criptografia dos dados (quem tem acesso ao navegador ou à conta ainda consegue ler o armazenamento).

const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const MIN_PASSWORD = 4;

export async function hashPassword(password, { salt = null, iterations = 150000 } = {}) {
  const saltBytes = salt ? fromB64(salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return { salt: toB64(saltBytes), hash: toB64(bits), iterations };
}

export async function checkPassword(password, lock) {
  if (!lock?.hash) return true;
  const r = await hashPassword(password, { salt: lock.salt, iterations: lock.iterations });
  return r.hash === lock.hash;
}

/** Cria o registro da senha (para salvar nas configurações). */
export async function makeLock(password, hint = '') {
  if (String(password).length < MIN_PASSWORD) throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  return { ...(await hashPassword(password)), hint: String(hint ?? '').trim().slice(0, 80), at: new Date().toISOString() };
}

export const MASK = '•••';
/** Troca valores em dinheiro de um texto por •••, mantendo a moeda (R$ 1.234,56 → R$ •••). */
export const maskMoney = (text) => String(text).replace(/(R\$|US\$)\s?-?\+?\d[\d.,]*/g, `$1 ${MASK}`);
