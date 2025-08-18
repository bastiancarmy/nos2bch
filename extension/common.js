// extension/common.js
import browser from 'webextension-polyfill'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hexToBytes } from '@noble/hashes/utils'
import { encode, decode } from 'cashaddrjs'
import { ElectrumClient } from '@electrum-cash/network'  // Updated import per README

const ELECTRUM_SERVERS = [
  { host: 'electrum.imaginary.cash', port: 50002, protocol: 'ssl' },
  { host: 'cashnode.bch.ninja', port: 50002, protocol: 'ssl' },
  { host: 'fulcrum.criptolayer.net', port: 50002, protocol: 'ssl' }  // Fallbacks with high uptime
];

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

export function deriveBCHAddress(pubkeyHex) {
  const xBytes = hexToBytes(pubkeyHex)
  let compressedHex
  try {
    // Try even y (prefix 02)
    const tempCompressed = '02' + pubkeyHex
    secp.Point.fromHex(tempCompressed) // Validates
    compressedHex = tempCompressed
  } catch {
    // Odd y (prefix 03)
    const tempCompressed = '03' + pubkeyHex
    secp.Point.fromHex(tempCompressed)
    compressedHex = tempCompressed
  }
  const pubBytes = hexToBytes(compressedHex)
  const pkh = ripemd160(sha256(pubBytes))
  return encode('bitcoincash', 'P2PKH', pkh)
}

export async function getBCHBalance(address) {
  const client = await connectElectrum();
  try {
    const balance = await client.request('blockchain.scripthash.get_balance', addressToScripthash(address));
    return (balance.confirmed + balance.unconfirmed) / 100000000;  // Sat to BCH
  } catch (err) {
    console.error('Electrum balance fetch failed:', err);
    return 0;
  }
}

export async function getTxHistory(address) {
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
  try {
    const fee = await client.request('blockchain.estimatefee', 2);  // Estimate for 2 blocks (fast)
    const feeRate = Math.max(1, Math.round(fee * 100000000));  // BCH to sat/byte
    await browser.storage.local.set({lastFeeRate: feeRate, lastFeeRateTime: Date.now()})
    return feeRate
  } catch (err) {
    console.error('Electrum fee fetch failed:', err);
    return 1;  // Fallback
  }
}

export async function getUtxos(address) {
  const client = await connectElectrum();
  try {
    const utxos = await client.request('blockchain.scripthash.listunspent', addressToScripthash(address));
    return utxos.map(utxo => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      value: utxo.value,
      scriptPubKey: utxo.script_pubkey  // If needed for signing
    }));
  } catch (err) {
    console.error('Electrum UTXO fetch failed:', err);
    return [];
  }
}

export async function broadcastTx(rawTx) {
  const client = await connectElectrum();
  try {
    const txid = await client.request('blockchain.transaction.broadcast', rawTx);
    return txid;
  } catch (err) {
    console.error('Electrum broadcast failed:', err);
    throw err;
  }
}

function addressToScripthash(address) {
  const { prefix, type, hash } = decode(address);
  const script = new Uint8Array([0x76, 0xa9, hash.byteLength, ...hash, 0x88, 0xac]);
  const hashed = sha256(script);
  // Reverse the hash for scripthash
  return Array.from(hashed.reverse()).map(b => b.toString(16).padStart(2, '0')).join('');
}