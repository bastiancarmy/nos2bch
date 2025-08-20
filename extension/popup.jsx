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

  useEffect(() => {
    (async () => {
      const results = await browser.storage.local.get(['private_key']);
      if (results.private_key) {
        const sk = results.private_key // Hex string
        setPrivKey(sk)
        const pk = getPublicKey(sk)
        setNpub(nip19.npubEncode(pk))
        const address = await deriveBCHAddress(pk) // Now await
        setBchAddress(address)
        refreshBalance(address)
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
    } catch (err) {
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
      if (response.success) {
        setStatus(`Success! TxID: <a href="https://blockchair.com/bitcoin-cash/transaction/${response.txId}" target="_blank">${response.txId}</a>`)
        setRecipientNpub('')
        setAmountSat('')
        refreshBalance(bchAddress) // Refresh after success
        setTimeout(() => setStatus(''), 5000) // Clear status after 5s
      } else {
        setError(response.error || 'Unknown error')
      }
    } catch (err) {
      setError('Tip failed: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const formattedBalance = bchBalance !== null ? bchBalance.toLocaleString() + ' sats' : ''
  const formattedBCH = bchBalance !== null ? `(${(bchBalance / 100000000).toFixed(8)} BCH)` : ''
  const shortenedNpub = npub ? `${npub.slice(0, 10)}...${npub.slice(-10)}` : ''

  return (
    <div style={{ padding: '10px', width: '300px' }}>
      <h1>nos2bch</h1>
      {npub && <div>Npub: {shortenedNpub}</div>}
      {npub && <QRCodeSVG value={npub.toUpperCase()} size={128} level="H" style={{margin: '10px 0'}} />}
      {bchAddress && <div>BCH Address: {bchAddress}</div>}
      <div>Balance: {balanceLoading ? 'Loading...' : `${formattedBalance} ${formattedBCH}`}</div>
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
      <label style={{display: 'flex', alignItems: 'center', marginBottom: '5px'}}>
        <input
          type="checkbox"
          checked={notify}
          onChange={e => setNotify(e.target.checked)}
        />
        Notify recipient via public Nostr note
      </label>
      <button onClick={handleTip} disabled={!bchBalance || bchBalance < 546 || loading}>
        {loading ? 'Tipping...' : 'Send Tip'}
      </button>
      {status && <div style={{color: 'green', wordBreak: 'break-all'}} dangerouslySetInnerHTML={{__html: status}} />}
      {error && <div style={{color: 'red'}}>{error}</div>}
    </div>
  )
}

createRoot(document.getElementById('main')).render(
  <ErrorBoundary>
    <Popup />
  </ErrorBoundary>
);