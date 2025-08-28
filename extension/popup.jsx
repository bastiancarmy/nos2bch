// extension/popup.jsx - Merged improvements
import {getPublicKey} from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
import {hexToBytes} from '@noble/hashes/utils'
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import { QRCodeSVG } from 'qrcode.react'
import browser from 'webextension-polyfill'
import {deriveBCHAddress, getBCHBalance} from './common'

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    return this.state.hasError ? <div>Error: {this.state.error.message}</div> : this.props.children;
  }
}

function Popup() {
  const [npub, setNpub] = useState('')
  const [privKey, setPrivKey] = useState(null)
  const [bchAddress, setBchAddress] = useState('')
  const [bchBalance, setBchBalance] = useState(null)
  const [recipientNpub, setRecipientNpub] = useState('')
  const [amountSat, setAmountSat] = useState('')
  const [notify, setNotify] = useState(true) // Default true
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [result, setResult] = useState(null)  // New state for result
  const [copiedNpub, setCopiedNpub] = useState(false)
  const [copiedBCH, setCopiedBCH] = useState(false)

  useEffect(() => {
    (async () => {
      const results = await browser.storage.local.get(['private_key', 'lastBchBalance', 'lastBchBalanceTime']);
      if (results.private_key) {
        const sk = results.private_key // Hex string
        setPrivKey(sk)
        const pubHex = getPublicKey(sk)
        setNpub(nip19.npubEncode(pubHex))
        try {
          const address = await deriveBCHAddress(pubHex) // Await
          setBchAddress(address)
          if (results.lastBchBalanceTime && Date.now() - results.lastBchBalanceTime < 600000) {
            setBchBalance(results.lastBchBalance)
            setBalanceLoading(false)
          } else {
            refreshBalance(address)
          }
        } catch (err) {
          setError('Address derivation failed: ' + err.message)
        }
      } else {
        setError('No private key set. Please configure in options.')
      }
    })();
  }, [])

  async function refreshBalance(address) {
    setBalanceLoading(true)
    try {
      const balanceBCH = await getBCHBalance(address)
      const sats = Math.floor(balanceBCH * 100000000)
      setBchBalance(sats)
      await browser.storage.local.set({lastBchBalance: sats, lastBchBalanceTime: Date.now()})
    } catch (err) {
      console.error('Balance fetch error in popup:', err) // Log for debugging
      setBchBalance(0)
      setError('Error loading balance: ' + err.message)
    } finally {
      setBalanceLoading(false)
    }
  }

  async function handleTip() {
    if (!recipientNpub.startsWith('npub1') || amountSat < 1000 || amountSat > bchBalance - 1000) {
      setError('Invalid npub or amount (min 1000 sats, max available - fee buffer)')
      return
    }
    setLoading(true)
    setError('')
    setStatus('Sending tip...')
    try {
      const response = await browser.runtime.sendMessage({
        type: 'tipBCH',
        params: { recipientNpub, amountSat: parseInt(amountSat), notify }
      })
      console.log('Tip response:', response);  // Enhanced logging
      setResult(response)  // Set result
      if (response.txid) {  // Adjusted for {txid} or {error: msg}
        setStatus(`Success! TxID: <a href="https://blockchair.com/bitcoin-cash/transaction/${response.txid}" target="_blank">${response.txid}</a>`)
        setRecipientNpub('')
        setAmountSat('')
        refreshBalance(bchAddress) // Refresh after success
        setTimeout(() => setStatus(''), 5000) // Clear status after 5s
      } else if (response.error) {
        console.error('Tip error details:', response.error);  // Log full error object
        setError(response.error.message || response.error || 'Unknown error')  // Extract message if object
      } else {
        setError('Unexpected response format')
      }
    } catch (err) {
      console.error('Tip exception:', err);  // Enhanced logging
      setResult({error: err.message})  // Set error as string
      setError('Tip failed: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const formattedBalance = bchBalance !== null ? bchBalance.toLocaleString() + ' sats' : ''
  const formattedBCH = bchBalance !== null ? `(${(bchBalance / 100000000).toFixed(8)} BCH)` : ''
  const abbreviate = (str) => `${str.slice(0, 6)}...${str.slice(-6)}`

  return (
    <div style={{ padding: '10px', width: '300px' }}>
      <h1>nos2bch</h1>
      {npub && (
        <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
          <div>Npub: {abbreviate(npub)}</div>
          <button onClick={() => {navigator.clipboard.writeText(npub); setCopiedNpub(true); setTimeout(() => setCopiedNpub(false), 2000);}} aria-label="Copy npub">
            {copiedNpub ? 'Copied!' : 'Copy'}
          </button>
          <QRCodeSVG value={npub.toUpperCase()} size={128} level="H" />
        </div>
      )}
      {bchAddress && (
        <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
          <div>BCH Address: {abbreviate(bchAddress)}</div>
          <button onClick={() => {navigator.clipboard.writeText(bchAddress); setCopiedBCH(true); setTimeout(() => setCopiedBCH(false), 2000);}} aria-label="Copy BCH Address">
            {copiedBCH ? 'Copied!' : 'Copy'}
          </button>
          <QRCodeSVG value={bchAddress.toUpperCase()} size={128} level="H" />
        </div>
      )}
      <div>Balance: {balanceLoading ? <span>Loading... <span className="spinner" /></span> :
        (bchBalance !== null ? `${formattedBalance} ${formattedBCH}` : 'Error - <button onClick={() => refreshBalance(bchAddress)}>Retry</button>')}</div>
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
      <label style={{fontSize: 'small', display: 'flex', alignItems: 'center', marginBottom: '5px'}}>
        <input
          type="checkbox"
          checked={notify}
          onChange={e => setNotify(e.target.checked)}
        />
        Notify recipient via encrypted DM (kind 4)
      </label>
      <button onClick={handleTip} disabled={!bchBalance || bchBalance < 546 || loading}>
        {loading ? 'Tipping...' : 'Send Tip'}
      </button>
      {status && <div style={{color: 'green', wordBreak: 'break-all'}} dangerouslySetInnerHTML={{__html: status}} />}
      {error && <div style={{color: 'red'}}>{error}</div>}
      {result && (
        <div>
          Result:
          <pre>
            {result.error 
              ? `Error: ${typeof result.error === 'object' ? result.error.message : result.error}`  // Enhanced: handle object
              : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('main')).render(
  <ErrorBoundary>
    <Popup />
  </ErrorBoundary>
);