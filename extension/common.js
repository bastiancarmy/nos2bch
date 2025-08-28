// extension/common.js

// common.js

import browser from 'webextension-polyfill'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { ElectrumClient } from '@electrum-cash/network'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

const ELECTRUM_SERVERS = [
  { host: 'cashnode.bch.ninja', port: 50002, protocol: 'ssl' },
  { host: 'fulcrum.criptolayer.net', port: 50002, protocol: 'ssl' },
  { host: 'fulcrum.aglauck.com', port: 50002, protocol: 'ssl' },
  { host: 'fulcrum.jettscythe.xyz', port: 50002, protocol: 'ssl' },
  { host: 'bch.cyberbits.eu', port: 50002, protocol: 'ssl' },
  { host: 'bch.reichster.de', port: 50002, protocol: 'ssl' },
  { host: 'blackie.c3-soft.com', port: 50002, protocol: 'ssl' },
  { host: 'fulcrum-cash.1209k.com', port: 50002, protocol: 'ssl' },
  { host: 'electroncash.dk', port: 50002, protocol: 'ssl' },
  { host: 'niblerino.com', port: 50002, protocol: 'ssl' },
  { host: 'bch0.kister.net', port: 50002, protocol: 'ssl' },
  { host: 'electrum.imaginary.cash', port: 50002, protocol: 'ssl' },
  { host: 'bch.imaginary.cash', port: 50002, protocol: 'ssl' },
  { host: 'bch.loping.net', port: 50002, protocol: 'ssl' },
  { host: 'bch.aftrek.org', port: 50002, protocol: 'ssl' },
  { host: 'bitcoincash.stackwallet.com', port: 50002, protocol: 'ssl' },
  { host: 'bch.soul-dev.com', port: 50002, protocol: 'ssl' },
  { host: 'electron.jochen-hoenicke.de', port: 51002, protocol: 'ssl' },
  { host: 'bitcoincash.network', port: 50002, protocol: 'ssl' },
];

// Helper to shuffle array for load balancing
function shuffleArray(array) {
  return array.sort(() => Math.random() - 0.5);
}

export async function getBCHBalance(address, forceRefresh = false, inSats = false) {
  address = address.toLowerCase();
  const cacheKey = `cached_balance_${address}`;
  const cached = await browser.storage.local.get(cacheKey);
  if (!forceRefresh && cached[cacheKey] && Date.now() - cached[cacheKey].timestamp < 300000) { // 5 min cache
    const totalSats = cached[cacheKey].balance;
    return inSats ? totalSats : totalSats / 100000000;
  }

  const servers = shuffleArray([...ELECTRUM_SERVERS]); // Shuffle for each call
  for (let server of servers) {
    try {
      const client = await connectElectrum(server); // Assuming connectElectrum accepts server object
      const balancePromise = client.request('blockchain.scripthash.get_balance', addressToScripthash(address));
      const balance = await Promise.race([balancePromise, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 5000))]);
      const totalSats = balance.confirmed + balance.unconfirmed;
      await browser.storage.local.set({ [cacheKey]: { balance: totalSats, timestamp: Date.now() } }); // Cache
      return inSats ? totalSats : totalSats / 100000000;
    } catch (err) {
      console.error(`Electrum balance fetch failed on ${server.host}:`, err);
    }
  }
  // Fallback to cache if all fail (even if expired)
  if (cached[cacheKey]) {
    const totalSats = cached[cacheKey].balance;
    return inSats ? totalSats : totalSats / 100000000;
  }
  return 0;
}

let electrumClient = null;

async function connectElectrum(retries = 3) {
  if (!electrumClient) {
    for (let attempt = 0; attempt < retries; attempt++) {
      for (const server of ELECTRUM_SERVERS) {
        try {
          electrumClient = new ElectrumClient('nos2bch', '1.4.1', server.host, server.port, server.protocol);
          await electrumClient.connect();
          return electrumClient;
        } catch (err) {
          console.error(`Failed to connect to ${server.host} (attempt ${attempt + 1}):`, err);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));  // Backoff retry
    }
    throw new Error('No Electrum servers available after retries');
  }
  return electrumClient;
}

export const NO_PERMISSIONS_REQUIRED = {
  replaceURL: true
}

export const PERMISSION_NAMES = Object.fromEntries([
  ['getPublicKey', 'read your public key'],
  ['signEvent', 'sign events using your private key'],
  ['nip04.encrypt', 'encrypt messages to peers'],
  ['nip04.decrypt', 'decrypt messages from peers'],
  ['nip44.encrypt', 'encrypt messages to peers'],
  ['nip44.decrypt', 'decrypt messages from peers'],
  ['tipBCH', 'send BCH tips using your private key']
])

function matchConditions(conditions, event) {
  if (conditions?.kinds) {
    if (event.kind in conditions.kinds) return true
    else return false
  }
  return true
}

export async function getPermissionStatus(host, type, event) {
  const { policies } = await browser.storage.local.get('policies')
  const answers = [true, false]
  for (let i = 0; i < answers.length; i++) {
    const accept = answers[i]
    const { conditions } = policies?.[host]?.[accept]?.[type] || {}
    if (conditions) {
      if (type === 'signEvent') {
        if (matchConditions(conditions, event)) {
          return accept // may be true or false
        } else {
          // if this doesn't match we just continue so it will either match for the opposite answer (reject)
          // or it will end up returning undefined at the end
          continue
        }
      } else {
        return accept // may be true or false
      }
    }
  }
  return undefined
}

export async function updatePermission(host, type, accept, conditions) {
  const { policies = {} } = await browser.storage.local.get('policies')
  // if the new conditions is "match everything", override the previous
  if (Object.keys(conditions).length === 0) {
    conditions = {}
  } else {
    // if we already had a policy for this, merge the conditions
    const existingConditions = policies[host]?.[accept]?.[type]?.conditions
    if (existingConditions) {
      if (existingConditions.kinds && conditions.kinds) {
        Object.keys(existingConditions.kinds).forEach(kind => {
          conditions.kinds[kind] = true
        })
      }
    }
  }
  // if we have a reverse policy (accept / reject) that is exactly equal to this, remove it
  const other = !accept
  const reverse = policies?.[host]?.[other]?.[type]
  if (
    reverse &&
    JSON.stringify(reverse.conditions) === JSON.stringify(conditions)
  ) {
    delete policies[host][other][type]
  }
  // insert our new policy
  policies[host] = policies[host] || {}
  policies[host][accept] = policies[host][accept] || {}
  policies[host][accept][type] = {
    conditions, // filter that must match the event (in case of signEvent)
    created_at: Math.round(Date.now() / 1000)
  }
  browser.storage.local.set({ policies })
}

export async function removePermissions(host, accept, type) {
  const { policies = {} } = await browser.storage.local.get('policies')
  delete policies[host]?.[accept]?.[type]
  browser.storage.local.set({ policies })
}

export async function showNotification(host, answer, type, params) {
  const { notifications } = await browser.storage.local.get('notifications')
  if (notifications) {
    const action = answer ? 'allowed' : 'denied'
    browser.notifications.create(undefined, {
      type: 'basic',
      title: `${type} ${action} for ${host}`,
      message: JSON.stringify(
        params?.event
          ? {
              kind: params.event.kind,
              content: params.event.content,
              tags: params.event.tags
            }
          : params,
        null,
        2
      ),
      iconUrl: 'icons/48x48.png'
    })
  }
}

export async function getPosition(width, height) {
  let left = 0
  let top = 0
  try {
    const lastFocused = await browser.windows.getLastFocused()
    if (
      lastFocused &&
      lastFocused.top !== undefined &&
      lastFocused.left !== undefined &&
      lastFocused.width !== undefined &&
      lastFocused.height !== undefined
    ) {
      // Position window in the center of the lastFocused window
      top = Math.round(lastFocused.top + (lastFocused.height - height) / 2)
      left = Math.round(lastFocused.left + (lastFocused.width - width) / 2)
    } else {
      console.error('Last focused window properties are undefined.')
    }
  } catch (error) {
    console.error('Error getting window position:', error)
  }
  return {
    top,
    left
  }
}

// --- Added BCH Functions ---

export function _hash160(x) {
  return ripemd160(sha256(x));
}

export function _encodeDer(r, s) {
  function encodeInt(val) {
    let bytes = [];
    let tmp = val;
    if (tmp === 0n) bytes.push(0);
    while (tmp > 0n) {
      bytes.push(Number(tmp & 0xffn));
      tmp >>= 8n;
    }
    bytes = bytes.reverse();
    if (bytes[0] & 0x80) bytes.unshift(0);
    return new Uint8Array([0x02, bytes.length, ...bytes]);
  }
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const totalLen = rEnc.length + sEnc.length;
  return new Uint8Array([0x30, totalLen, ...rEnc, ...sEnc]);
}

export async function getTxHistory(address) {
  address = address.toLowerCase();
  const client = await connectElectrum();
  try {
    const history = await client.request('blockchain.scripthash.get_history', addressToScripthash(address));
    return history.map(tx => ({
      hash: tx.tx_hash,
      time: tx.timestamp,
      balance_change: tx.value / 100000000,  // Sat to BCH
      confirmed: tx.height > 0
    }));
  } catch (err) {
    console.error('Electrum history fetch failed:', err);
    return [];
  }
}

export async function getFeeRate() {
  // Cache fee rate (5min expiry)
  let {lastFeeRate, lastFeeRateTime} = await browser.storage.local.get(['lastFeeRate', 'lastFeeRateTime'])
  if (lastFeeRate && Date.now() - lastFeeRateTime < 300000) {
    return lastFeeRate
  }
  const client = await connectElectrum();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let fee = await client.request('blockchain.estimatefee', 2);  // Estimate for 2 blocks (fast)
      if (fee < 0) fee = 0.00001; // Fallback if no estimate
      const feeRate = Math.max(1, Math.round(fee * 100000));  // BCH/kb to sat/byte
      await browser.storage.local.set({lastFeeRate: feeRate, lastFeeRateTime: Date.now()})
      return feeRate
    } catch (err) {
      console.error(`Electrum fee fetch attempt ${attempt} failed:`, err);
      if (attempt === 3) {
        console.error('Electrum fee fetch failed after retries:', err);
        return 1; 
      }
    }
  }
}

export async function getUtxos(address) {
  address = address.toLowerCase();
  const client = await connectElectrum();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const utxos = await client.request('blockchain.scripthash.listunspent', addressToScripthash(address));
      return utxos.map(utxo => ({
        txid: utxo.tx_hash,
        vout: utxo.tx_pos,
        value: utxo.value,
        height: utxo.height, // Always present; 0 if unconfirmed/mempool
        token_data: utxo.token_data, // Optional; undefined if no CashTokens
        scriptPubKey: utxo.script_pubkey // If needed for signing (keep if used elsewhere)
      }));
    } catch (err) {
      console.error(`Electrum UTXO fetch attempt ${attempt} failed:`, err);
      if (attempt === 3) {
        console.error('Electrum UTXO fetch failed after retries:', err);
        return [];
      }
    }
  }
}

export async function broadcastTx(rawTx) {
  const client = await connectElectrum();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await client.request('blockchain.transaction.broadcast', rawTx);
      console.log('Raw broadcast response:', response);
      if (typeof response === 'object' && response.error) {
        throw new Error('Broadcast error: ' + response.error);
      } else if (typeof response !== 'string' || response.length !== 64 || !/^[0-9a-f]{64}$/i.test(response)) {
        throw new Error('Invalid broadcast response: ' + JSON.stringify(response));
      }
      console.log(`Broadcast successful, txid: ${response}`);
      return response;
    } catch (err) {
      console.error(`Electrum broadcast attempt ${attempt} failed:`, err);
      if (attempt === 3) {
        throw err;
      }
    }
  }
}

function addressToScripthash(address) {
  const [hrp, data5] = cashDecode(address);
  if (!hrp || hrp !== 'bitcoincash') throw new Error('Invalid CashAddr prefix');
  const payload = convertbits(data5, 5, 8, false);
  if (!payload || payload.length < 21) throw new Error('Invalid CashAddr payload');
  const version = payload[0];
  if (version !== 0) throw new Error('Only P2PKH (version 0) supported');
  const hash = new Uint8Array(payload.slice(1)); // PKH (20 bytes)
  if (hash.length !== 20) throw new Error('Invalid PKH length');
  const script = new Uint8Array([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);
  const hashed = sha256(script);
  const reversed = reverseBytes(hashed);
  return Array.from(reversed).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Supporting CashAddr functions (pure JS, no deps beyond noble)
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function cashHrpExpand(hrp) {
  const expanded = [];
  for (let char of hrp) {
    expanded.push(char.charCodeAt(0) & 31);
  }
  expanded.push(0);
  return expanded;
}

function polymod(values) {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let chk = 1n;
  for (let v of values) {
    const top = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= GEN[i];
    }
  }
  return chk ^ 1n;
}

function cashCreateChecksum(hrp, data) {
  const values = cashHrpExpand(hrp).concat(data);
  const mod = polymod(values.concat(new Array(8).fill(0)));
  const checksum = [];
  for (let i = 0; i < 8; i++) {
    checksum.push(Number((mod >> (5n * (7n - BigInt(i)))) & 31n));
  }
  return checksum;
}

function cashVerifyChecksum(hrp, data) {
  return polymod(cashHrpExpand(hrp).concat(data)) === 0n;
}

function cashDecode(addr) {
  if (addr.toLowerCase() !== addr && addr.toUpperCase() !== addr) throw new Error('Mixed case CashAddr');
  addr = addr.toLowerCase();
  const parts = addr.split(':');
  const hrp = parts[0];
  const encoded = parts[1] || addr; // Handle prefixless
  const data = [];
  for (let char of encoded) {
    const d = CHARSET.indexOf(char);
    if (d === -1) throw new Error('Invalid character in CashAddr');
    data.push(d);
  }
  if (!cashVerifyChecksum(hrp, data)) throw new Error('Invalid CashAddr checksum');
  return [hrp, data.slice(0, -8)]; // Return hrp and data without checksum
}

function convertbits(data, frombits, tobits, pad = true) {
  let acc = 0n;
  let bits = 0;
  const ret = [];
  const maxv = (1n << BigInt(tobits)) - 1n;
  const max_acc = (1n << BigInt(frombits + tobits - 1)) - 1n;

  for (let value of data) {
    value = BigInt(value);
    if (value < 0n || (value >> BigInt(frombits)) !== 0n) {
      throw new Error('Invalid value in convertbits');
    }
    acc = ((acc << BigInt(frombits)) | value) & max_acc;
    bits += frombits;
    while (bits >= tobits) {
      bits -= tobits;
      ret.push(Number((acc >> BigInt(bits)) & maxv));
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push(Number((acc << BigInt(tobits - bits)) & maxv));
    }
  } else if (bits >= frombits || ((acc << BigInt(tobits - bits)) & maxv) !== 0n) {
    throw new Error('Invalid padding in convertbits');
  }

  return new Uint8Array(ret);
}

function encodeCashAddr(prefix, type, payload) {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const version = (type << 3) | 0; // P2PKH type 0, size 0 (20 bytes)
  const converted = convertbits(new Uint8Array([version, ...payload]), 8, 5);
  
  const prefixData = [];
  for (let char of prefix) prefixData.push(char.charCodeAt(0) & 0x1f);
  const checksumData = new Uint8Array([...prefixData, 0, ...converted, 0, 0, 0, 0, 0, 0, 0, 0]);
  
  const checksum = polymod(checksumData);
  const checksumBytes = [];
  for (let i = 0; i < 8; i++) {
    checksumBytes.push(Number((checksum >> (BigInt(5) * BigInt(7 - i))) & 0x1fn));
  }
  
  let encoded = prefix + ':';
  for (let byte of converted) encoded += charset[byte];
  for (let byte of checksumBytes) encoded += charset[byte];
  
  return encoded;
}

export function deriveBCHAddress(pubHex) {
  let pubCompressed = new Uint8Array([0x02, ...hexToBytes(pubHex)]);
  try {
    secp.Point.fromHex(pubCompressed); // Even parity
  } catch {
    pubCompressed = new Uint8Array([0x03, ...hexToBytes(pubHex)]); // Odd parity
    secp.Point.fromHex(pubCompressed);
  }
  const h = _hash160(pubCompressed);
  return encodeCashAddr('bitcoincash', 0, h);
}

export function getBalanceFromUtxos(utxos) {
  return utxos.reduce((sum, utxo) => sum + utxo.value, 0);
}

export function validateUtxos(utxos) {
  console.log('Validating UTXOs - Raw input:', JSON.stringify(utxos, null, 2)); // Log before filter
  const filtered = utxos.filter(utxo => {
    const isValid = utxo.height >= 0 && (utxo.token_data == null); // Updated to utxo.token_data == null to handle undefined/null explicitly (covers if API sets null)
    console.log(`UTXO ${utxo.txid}:${utxo.vout} - height: ${utxo.height}, token_data: ${JSON.stringify(utxo.token_data)}, valid: ${isValid}`);
    return isValid;
  });
  console.log('Filtered valid UTXOs:', JSON.stringify(filtered, null, 2));
  return filtered;
}

function reverseBytes(bytes) {
  const rev = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) rev[i] = bytes[bytes.length - 1 - i];
  return rev;
}

//schnorr support
export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

export function bytesToNumberBE(bytes) {
  let num = 0n;
  for (const byte of bytes) {
    num = (num * 256n) + BigInt(byte);
  }
  return num;
}

export function numberToBytesBE(num, len) {
  const bytes = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = Number(num & 255n);
    num >>= 8n;
  }
  return bytes;
}

export function rfc6979K(privBytes, h1, additional) {
  const n = secp.CURVE.n;
  let k = new Uint8Array(32).fill(0);
  let v = new Uint8Array(32).fill(1);
  k = secp.etc.hmacSha256Sync(k, secp.etc.concatBytes(v, new Uint8Array([0x00]), privBytes, h1, additional));
  v = secp.etc.hmacSha256Sync(k, v);
  k = secp.etc.hmacSha256Sync(k, secp.etc.concatBytes(v, new Uint8Array([0x01]), privBytes, h1, additional));
  v = secp.etc.hmacSha256Sync(k, v);
  let attempts = 0;
  while (attempts < 10000) {
    v = secp.etc.hmacSha256Sync(k, v);
    const candidate = bytesToNumberBE(v);
    if (candidate >= 1n && candidate < n) return candidate;
    k = secp.etc.hmacSha256Sync(k, secp.etc.concatBytes(v, new Uint8Array([0x00])));
    v = secp.etc.hmacSha256Sync(k, v);
    attempts++;
  }
  throw new Error('Failed to generate deterministic k after max attempts');
}

export function modPow(base, exp, mod) {
  let res = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) res = (res * base) % mod;
    base = (base * base) % mod;
    exp /= 2n;
  }
  return res;
}

export function signSchnorr(sighash, privBytes) {
  const P = secp.CURVE.p;
  const n = secp.CURVE.n;
  const additional = utf8ToBytes('Schnorr+SHA256  '); // 16-byte ASCII with two spaces
  const k = rfc6979K(privBytes, sighash, additional);
  let R = secp.Point.BASE.multiply(k);
  const y = R.y;
  const jacobi = modPow(y, (P - 1n) / 2n, P);
  let kBig = k;
  if (jacobi === 0n) throw new Error('Invalid R Jacobi');
  if (jacobi !== 1n) {
    kBig = n - k;
    R = R.negate();
  }
  const rBig = R.x;
  const rBytes = numberToBytesBE(rBig, 32);
  const pubBytes = secp.getPublicKey(privBytes, true); // Compressed 33 bytes
  const eBytes = sha256(secp.etc.concatBytes(rBytes, pubBytes, sighash));
  const e = bytesToNumberBE(eBytes) % n;
  const privBig = bytesToNumberBE(privBytes);
  const sBig = (kBig + e * privBig) % n;
  const sBytes = numberToBytesBE(sBig, 32);
  return secp.etc.concatBytes(rBytes, sBytes); // 64-byte sig
}