// extension/common.js
import browser from 'webextension-polyfill'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hexToBytes } from '@noble/hashes/utils'
import { encode } from 'cashaddrjs'

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

export const BLOCKCHAIR_API = 'https://api.blockchair.com/bitcoin-cash/';

function hash160(pubBytes) {
  return ripemd160(sha256(pubBytes));
}

export function deriveBCHAddress(pubkeyHex) {
  const xBytes = hexToBytes(pubkeyHex);
  let compressedHex;
  try {
    // Try even y (prefix 02)
    const tempCompressed = '02' + pubkeyHex;
    secp.Point.fromHex(tempCompressed);  // Validates
    compressedHex = tempCompressed;
  } catch {
    // Odd y (prefix 03)
    const tempCompressed = '03' + pubkeyHex;
    secp.Point.fromHex(tempCompressed);
    compressedHex = tempCompressed;
  }
  const pubBytes = hexToBytes(compressedHex);
  const pkh = hash160(pubBytes);
  return encode('bitcoincash', 'P2PKH', pkh);
}

export async function getBCHBalance(address) {
  try {
    const res = await fetch(`${BLOCKCHAIR_API}dashboards/address/${address}`);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    const { data } = await res.json();
    // Balance in satoshis; convert to BCH
    return (data[address]?.address?.balance || 0) / 100000000;
  } catch (error) {
    console.error('Failed to fetch BCH balance:', error);
    return 0;
  }
}

export async function getTxHistory(address) {
  try {
    const res = await fetch(`${BLOCKCHAIR_API}dashboards/address/${address}?transaction_details=true`);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    const { data } = await res.json();
    return (data[address]?.transactions || []).map(tx => ({
      hash: tx.hash,
      time: tx.time,
      // to BCH
      balance_change: tx.balance_change / 100000000,
      confirmed: tx.block_id > 0
    }));
  } catch (error) {
    console.error('Failed to fetch tx history:', error);
    return [];
  }
}