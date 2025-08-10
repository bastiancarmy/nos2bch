// extension/common.js
import browser from 'webextension-polyfill'
import { hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { encode } from 'cashaddrjs'

export const API_BASE = 'https://api.fullstack.cash/v5/electrumx/'

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
  ['getBCHAddress', 'get your BCH address'],
  ['getBCHBalance', 'get your BCH balance'],
  ['tipBCH', 'tip BCH using your key']
])

function matchConditions(conditions, type, params) {
  if (type === 'signEvent') {
    if (conditions?.kinds) {
      if (params.kind in conditions.kinds) return true
      else return false
    }
  } else if (type === 'tipBCH') {
    if (conditions?.maxAmountSat) {
      return params.amountSat <= conditions.maxAmountSat
    }
  }
  return true
}

export async function getPermissionStatus(host, type, params) {
  const { policies } = await browser.storage.local.get('policies')

  const answers = ['true', 'false']
  for (let i = 0; i < answers.length; i++) {
    const accept = answers[i]
    const { conditions } = policies?.[host]?.[accept]?.[type] || {}

    if (matchConditions(conditions, type, params)) {
      return accept === 'true'
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
      } else if (existingConditions.maxAmountSat && conditions.maxAmountSat) {
        conditions.maxAmountSat = Math.min(conditions.maxAmountSat, existingConditions.maxAmountSat)
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
    conditions,
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
