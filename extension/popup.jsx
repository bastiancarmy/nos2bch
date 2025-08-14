// extension/popup.jsx - Fixed: Switched to 'qrcode.react' with named import { QRCodeSVG as QRCode } (per web search—avoids default object issue in bundling; install 'yarn add qrcode.react'); kept minimal tipping, balance=0 (debug); applied .npub/.address classes for wrapping (assume styles.css updated). Preserves nos2x.
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'
import {getPublicKey} from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
import { QRCodeSVG as QRCode } from 'qrcode.react' // Fixed: Named import from 'qrcode.react' (install if needed)—resolves object type error; alternative if 'react-qr-code' persists issue.
import {deriveBCHAddress} from './common'

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    return this.state.hasError ? <div>Error: {this.state.error.message}. Reload.</div> : this.props.children;
  }
}

function Popup() {
  const [hasKey, setHasKey] = useState(false)
  const [npub, setNpub] = useState('')
  const [bchAddress, setBchAddress] = useState('')
  const [balanceSat, setBalanceSat] = useState(0) // Debug: Always 0, no fetch
  const [recipientNpub, setRecipientNpub] = useState('')
  const [amountSat, setAmountSat] = useState('')
  const [tipMessage, setTipMessage] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true)
    console.log('Loading popup data...');
    let {private_key, prompted_for_key} = await browser.storage.local.get(['private_key', 'prompted_for_key']);
    console.log('Private key from storage:', !!private_key);
    if (private_key) {
      setHasKey(true)
      let pubkeyHex = getPublicKey(private_key)
      let npub = nip19.npubEncode(pubkeyHex)
      setNpub(npub)
      let address = deriveBCHAddress(pubkeyHex)
      setBchAddress(address)
      setBalanceSat(0) // Debug: No fetch, assume 0
    } else {
      console.error('No private key in storage');
      if (!prompted_for_key) {
        browser.runtime.openOptionsPage();
        await browser.storage.local.set({prompted_for_key: true});
      }
    }
    setLoading(false)
  }

  async function sendTip() {
    setTipMessage('')
    console.log('Sending tip request...'); // Debug log
    try {
      const response = await browser.runtime.sendMessage({
        type: 'tipBCH',
        params: { recipientNpub, amountSat: parseInt(amountSat) }
      })
      console.log('Tip response:', response); // Debug log
      if (response.error) {
        setTipMessage(`Error: ${response.error.message}`)
      } else {
        setTipMessage(`Tip sent! TxID: ${response.txid}`)
      }
    } catch (err) {
      console.error('Send tip error:', err); // Debug log
      setTipMessage(`Error sending tip: ${err.message}`)
    }
  }

  return (
    <div style={{padding: '10px', width: '300px', minHeight: '200px'}}> {/* Min-height prevents minimize/blank */}
      {loading ? (
        <div>Loading...</div>
      ) : hasKey ? (
        <>
          <div>npub:</div>
          <pre className="npub"> {/* Apply class for wrapping */}
            <code>{npub}</code>
          </pre>
          {npub && <QRCode value={npub} size={128} style={{margin: '10px 0'}} />}
          <div>BCH Address:</div>
          <pre className="address"> {/* Apply class for wrapping */}
            <code>{bchAddress}</code>
          </pre>
          <div>Balance: {balanceSat + ' sat (debug)'}</div>
          <h3>Tip BCH</h3>
          <input
            type="text"
            placeholder="Recipient npub"
            value={recipientNpub}
            onChange={e => setRecipientNpub(e.target.value)}
            style={{width: '100%', marginBottom: '10px'}}
          />
          <input
            type="number"
            placeholder="Amount in sat"
            value={amountSat}
            onChange={e => setAmountSat(e.target.value)}
            style={{width: '100%', marginBottom: '10px'}}
          />
          <button onClick={sendTip} disabled={!recipientNpub || !amountSat}>Send Tip</button>
          {tipMessage && <div style={{marginTop: '10px', color: tipMessage.startsWith('Error') ? 'red' : 'green'}}>{tipMessage}</div>}
        </>
      ) : (
        <div>No key set. Open options to generate.</div>
      )}
      <button onClick={() => browser.runtime.openOptionsPage()}>Options</button>
    </div>
  )
}

createRoot(document.getElementById('main')).render(<ErrorBoundary><Popup /></ErrorBoundary>);