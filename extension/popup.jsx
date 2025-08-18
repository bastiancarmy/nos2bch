// extension/popup.jsx - New file: Tip UI with npub/QR/address/balance display (similar to options); tip form (recipient npub, amount sat); button with loading spinner; status display (success txid link, error messages); disable button on zero/low balance; error boundary. Uses qrcode.react for QR.

import {bytesToHex, getPublicKey} from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import { QRCodeSVG } from 'qrcode.react'
import browser from 'webextension-polyfill'
import {deriveBCHAddress, getBCHBalance} from './common'  // Assume common.js exports these

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    return this.state.hasError ? <div>Error: {this.state.error.message}</div> : this.props.children;
  }
}

function Popup() {
  const [privKey, setPrivKey] = useState(null)
  const [npub, setNpub] = useState('')
  const [bchAddress, setBchAddress] = useState(null)
  const [bchBalance, setBchBalance] = useState(null)
  const [recipientNpub, setRecipientNpub] = useState('')
  const [amountSat, setAmountSat] = useState('')
  const [loading, setLoading] = useState(true)
  const [tipLoading, setTipLoading] = useState(false)
  const [tipStatus, setTipStatus] = useState(null)
  const [tipError, setTipError] = useState(null)

  useEffect(() => {
    browser.storage.local.get(['private_key']).then(results => {
      if (results.private_key) {
        const sk = results.private_key
        setPrivKey(sk)
        const pubHex = getPublicKey(sk)
        setNpub(nip19.npubEncode(pubHex))
        const address = deriveBCHAddress(pubHex)
        setBchAddress(address)
        getBCHBalance(address).then(balance => {
          setBchBalance(balance)  // sat
        }).catch(err => {
          setBchBalance(0)
          console.error('Balance error:', err)
        })
      }
      setLoading(false)
    })
  }, [])

  const handleTip = async () => {
    if (!recipientNpub || !amountSat || Number(amountSat) <= 0) {
      setTipError('Invalid recipient or amount')
      return
    }
    if (bchBalance < Number(amountSat) + 200) {  // Rough est fee buffer
      setTipError('Insufficient balance')
      return
    }
    setTipLoading(true)
    setTipError(null)
    setTipStatus(null)
    try {
      const response = await browser.runtime.sendMessage({
        method: 'tipBCH',
        params: { recipientNpub, amountSat: Number(amountSat) }
      })
      if (response.error) {
        setTipError(response.error.message || 'Tip failed')
      } else {
        setTipStatus(`Success! TxID: ${response.txId}`)
        // Refresh balance after success
        getBCHBalance(bchAddress).then(balance => setBchBalance(balance))
      }
    } catch (err) {
      setTipError(err.message || 'Tip error')
    } finally {
      setTipLoading(false)
    }
  }

  if (loading) return <div>Loading...</div>

  const canTip = bchBalance >= 546 && !!privKey

  return (
    <div style={{padding: '10px', width: '300px'}}>
      <h1>nos2bch</h1>
      {npub && (
        <>
          <div>Npub: {npub.slice(0, 10)}...{npub.slice(-10)}</div>
          <QRCodeSVG value={npub.toUpperCase()} size={128} style={{margin: '10px 0'}} />
        </>
      )}
      {bchAddress && <div>BCH Address: {bchAddress}</div>}
      <div>Balance: {bchBalance !== null ? bchBalance + ' sat' : 'Loading...'}</div>
      {bchBalance === 0 && <div style={{color: 'red'}}>Zero balance - fund your address to tip</div>}
      {bchBalance > 0 && bchBalance < 546 && <div style={{color: 'orange'}}>Dust balance - add more funds to tip</div>}
      <h2>Tip BCH</h2>
      <input
        type="text"
        placeholder="Recipient npub"
        value={recipientNpub}
        onChange={e => setRecipientNpub(e.target.value)}
        style={{width: '100%', marginBottom: '5px'}}
      />
      <input
        type="number"
        placeholder="Amount in sat"
        value={amountSat}
        onChange={e => setAmountSat(e.target.value)}
        style={{width: '100%', marginBottom: '5px'}}
      />
      <button onClick={handleTip} disabled={!canTip || tipLoading}>
        {tipLoading ? 'Tipping...' : 'Send Tip'}
      </button>
      {tipStatus && <div style={{color: 'green', wordBreak: 'break-all'}}>{tipStatus}</div>}
      {tipError && <div style={{color: 'red'}}>{tipError}</div>}
    </div>
  )
}

createRoot(document.getElementById('main')).render(
  <ErrorBoundary>
    <Popup />
  </ErrorBoundary>
);