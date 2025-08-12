// extension/common.js
import browser from 'webextension-polyfill'
import { sha256 } from '@noble/hashes/sha2'
import { ripemd160 } from '@noble/hashes/legacy'
import { encode } from 'cashaddrjs'
import { hexToBytes } from '@noble/hashes/utils'

export const API_BASE = 'https://api.fullstack.cash/v5/electrumx/'

export const NO_PERMISSIONS_REQUIRED = {
  replaceURL: true
}

export async function getPermissionStatus(host, type, event) {
  let { policies = {} } = await browser.storage.local.get('policies')
  let accepts = policies[host]
  if (!accepts) return null
  if (type === 'signEvent' && accepts.true && accepts.true.signEvent) {
    let conditions = accepts.true.signEvent.conditions
    if (conditions?.kinds?.[event.kind] === true) return true
  } else if (type === 'tipBCH' && accepts.true && accepts.true.tipBCH) {
    let conditions = accepts.true.tipBCH.conditions
    if (conditions?.max_amount === undefined || conditions.max_amount >= event.amountSat) return true
  }
  if (accepts.true?.[type]) return true
  if (accepts.false?.[type]) return false
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

export async function getBCHBalance(address) {
  try {
    const res = await fetch(`${API_BASE}balance/${address}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data.success) throw new Error(data.msg || 'API error')
    return data.balance.confirmed + data.balance.unconfirmed
  } catch (err) {
    throw new Error(`Balance fetch failed: ${err.message}`)
  }
}