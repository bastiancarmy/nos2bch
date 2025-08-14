// extension/common.js - Fixed: Parse JSON once (avoid body read error), log data; guards for null data; error msgs for 430/rate limits.
import browser from 'webextension-polyfill'
import { sha256 } from '@noble/hashes/sha2'
import { ripemd160 } from '@noble/hashes/legacy'
import { encode } from 'cashaddrjs'
import { hexToBytes } from '@noble/hashes/utils'

export const NO_PERMISSIONS_REQUIRED = {
  replaceURL: true
}

export const accepts = {
  true: {
    signEvent: { kinds: {} },
    tipBCH: {}
  },
  false: {
    signEvent: null,
    tipBCH: null
  }
}

export async function getPermissionStatus(host, type, params) {
  let { policies = {} } = await browser.storage.local.get('policies')
  let permission = policies[host]?.true?.[type] || policies[host]?.false?.[type]
  if (permission === undefined) return null

  if (permission === null) return false

  if (type === 'signEvent') {
    let { kinds } = permission.conditions
    if (Object.keys(kinds).length === 0) return true
    if (kinds[params.kind] === true) return true
    return false
  } else if (type === 'tipBCH') {
    // Add conditions if needed, e.g., max amount
    return true
  }

  return null
}

export async function updatePermission(host, type, accept, conditions) {
  let { policies = {} } = await browser.storage.local.get('policies')
  if (!policies[host]) policies[host] = {}
  if (!policies[host][accept]) policies[host][accept] = {}
  policies[host][accept][type] = { created_at: Math.round(Date.now() / 1000), conditions }
  await browser.storage.local.set({ policies })
}

export async function removePermissions(host, accept, type) {
  let { policies = {} } = await browser.storage.local.get('policies')
  if (policies[host]?.[accept]?.[type]) {
    delete policies[host][accept][type]
    if (Object.keys(policies[host][accept]).length === 0) delete policies[host][accept]
    if (Object.keys(policies[host]).length === 0) delete policies[host]
    await browser.storage.local.set({ policies })
  }
}

export async function showNotification(host, allowed, type, params) {
  let { notifications } = await browser.storage.local.get('notifications')
  if (!notifications) return
  if (typeof browser.notifications === 'undefined') return
  browser.notifications.create(Math.random().toString().slice(4), {
    type: 'basic',
    message: `${host} ${allowed ? 'now has' : 'was denied'} access to method nostr.${type}`,
    title: `${allowed ? 'ALLOWED' : 'DENIED'} ${type.toUpperCase()}`,
    iconUrl: 'icons/48x48.png'
  })
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

function _hash160(input) {
  return ripemd160(sha256(input))
}

export function deriveBCHAddress(pubkeyHex) {
  const xBytes = hexToBytes(pubkeyHex)
  const compressed = new Uint8Array(33)
  compressed[0] = 0x02
  compressed.set(xBytes, 1)
  const hash = _hash160(compressed)
  return encode('bitcoincash', 'P2PKH', hash)
}

export const BLOCKCHAIR_API = 'https://api.blockchair.com/bitcoin-cash/';

export async function getBCHBalance(address) {
  if (!address) return 0; // Guard
  try {
    const res = await fetch(`${BLOCKCHAIR_API}dashboards/address/${address}`);
    if (!res.ok) {
      if (res.status === 430) throw new Error('Rate limit exceeded (430)');
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    console.log('Balance data:', data); // Log after parse
    if (data.context.error) throw new Error(data.context.error);
    return data?.data?.[address]?.address?.balance || 0;
  } catch (err) {
    console.error('Balance fetch error:', err);
    return 0; // Fallback
  }
}

export async function getTxHistory(address) {
  if (!address) return [];
  try {
    const res = await fetch(`${BLOCKCHAIR_API}dashboards/address/${address}?transactions=true`);
    if (!res.ok) {
      if (res.status === 430) throw new Error('Rate limit exceeded (430)');
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    console.log('Tx history data:', data); // Log after parse
    return data?.data?.[address]?.transactions || [];
  } catch (err) {
    console.error('Tx history fetch error:', err);
    return [];
  }
}