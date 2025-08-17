// extension/popup.jsx - Full version with tip status handling (loading/success/error). Preserves all original nos2x functionality while adding BCH tipping UI/status.
import {hexToBytes} from '@noble/hashes/utils'
import {getPublicKey} from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import { QRCodeSVG } from 'qrcode.react'  // Switched to qrcode.react with named import for ESM/React 19 compat; install if needed: yarn add qrcode.react
import browser from 'webextension-polyfill'
import { deriveBCHAddress, getBCHBalance } from './common'  // Imported for BCH features

function Popup() {
  let [privateKey, setPrivateKey] = useState(null)
  let [npub, setNpub] = useState(null)
  let [bchAddress, setBchAddress] = useState(null)
  let [bchBalance, setBchBalance] = useState(null)
  let [tipRecipient, setTipRecipient] = useState('')
  let [tipAmount, setTipAmount] = useState(1000)
  let [tipStatus, setTipStatus] = useState({ loading: false, message: '', txId: null })  // Added for status

  useEffect(() => {
    browser.storage.local.get(['private_key']).then(results => {
      if (results.private_key) {
        let hex = results.private_key
        setPrivateKey(hex)
        let pubHex = getPublicKey(hex)
        setNpub(nip19.npubEncode(pubHex))
        setBchAddress(deriveBCHAddress(pubHex))
        getBCHBalance(deriveBCHAddress(pubHex)).then(balance => setBchBalance(balance)).catch(() => setBchBalance('Error'))
      }
    })
  }, [])

  async function handleTip() {
    if (!tipRecipient || tipAmount <= 0) {
      setTipStatus({ loading: false, message: 'Invalid recipient or amount' })
      return
    }
    setTipStatus({ loading: true, message: 'Sending tip...', txId: null })
    try {
      const response = await browser.runtime.sendMessage({
        type: 'tipBCH',
        params: { recipientNpub: tipRecipient, amountSat: tipAmount }
      })
      console.log('Tip response from background:', response);  // Added log for debugging
      if (response.success) {
        setTipStatus({ loading: false, message: 'Tip sent!', txId: response.txId })
      } else {
        setTipStatus({ loading: false, message: `Error: ${response.error}` })
      }
    } catch (err) {
      console.error('Tip send error:', err);  // Added log
      setTipStatus({ loading: false, message: `Error: ${err.message}` })
    }
  }

  return (
    <div style={{padding: '10px', width: '300px'}}>
      <h2>nos2bch</h2>
      {npub ? (
        <>
          <div>Nostr Public Key (npub):</div>
          <div style={{wordBreak: 'break-all'}}>{npub}</div>
          <QRCodeSVG value={npub.toUpperCase()} size={256} style={{height: 'auto', maxWidth: '100%', width: '100%'}} viewBox={`0 0 256 256`} />
          <div>BCH Address: {bchAddress}</div>
          <div>BCH Balance: {bchBalance !== null ? bchBalance + ' sat' : 'Loading...'}</div>
          <h3>Tip BCH</h3>
          <input
            type="text"
            placeholder="Recipient npub"
            value={tipRecipient}
            onChange={e => setTipRecipient(e.target.value)}
            style={{width: '100%', marginBottom: '10px'}}
          />
          <input
            type="number"
            placeholder="Amount (sat)"
            value={tipAmount}
            onChange={e => setTipAmount(Number(e.target.value))}
            style={{width: '100%', marginBottom: '10px'}}
          />
          <button onClick={handleTip} disabled={tipStatus.loading}>Tip BCH</button>
          {tipStatus.loading && <div>Sending...</div>}
          {tipStatus.message && <div>{tipStatus.message}</div>}
          {tipStatus.txId && <a href={`https://blockchair.com/bitcoin-cash/transaction/${tipStatus.txId}`} target="_blank">View Tx</a>}
        </>
      ) : (
        <div>
          <p>No private key set.</p>
          <button onClick={() => browser.runtime.openOptionsPage()}>Set up in options</button>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Popup />)