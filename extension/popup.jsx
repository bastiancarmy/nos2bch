// extension/popup.jsx (Switched to qrcode.react for React 19 compat; added ErrorBoundary/checks; imported styles.css for responsive QR/text)
import browser from 'webextension-polyfill'
import { createRoot } from 'react-dom/client'
import { getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import React, { useState, useRef, useEffect, Component } from 'react'
import { QRCodeSVG } from 'qrcode.react'  // Named import for ESM compat; install yarn add qrcode.react
import './styles.css'  // New: Import CSS for styles (ensure copied to dist via build.mjs)

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return <div>QR Error: {this.state.error.message}</div>
    }
    return this.props.children
  }
}

function Popup() {
  const [pubKey, setPubKey] = useState('')

  const keys = useRef([])

  const [recipient, setRecipient] = useState('')
  const [amountSat, setAmountSat] = useState(1000)

  useEffect(() => {
    browser.storage.local.get(['private_key', 'relays']).then(results => {
      if (results.private_key) {
        const hexKey = getPublicKey(results.private_key)
        const npubKey = nip19.npubEncode(hexKey)

        setPubKey(npubKey)

        keys.current.push(npubKey)
        keys.current.push(hexKey)

        if (results.relays) {
          const relaysList = []
          for (const url in results.relays) {
            if (results.relays[url].write) {
              relaysList.push(url)
              if (relaysList.length >= 3) break
            }
          }
          if (relaysList.length) {
            const nprofileKey = nip19.nprofileEncode({
              pubkey: hexKey,
              relays: relaysList
            })
            keys.current.push(nprofileKey)
          }
        }
      } else {
        setPubKey(null)
      }
    }).catch(err => console.error('Storage error:', err))
  }, [])

  async function handleTip() {
    console.log('Sending tip request...')
    try {
      const response = await browser.runtime.sendMessage({
        type: 'tipBCH',
        params: { recipientNpub: recipient, amountSat }
      })
      console.log('Tip response:', response)
      if (response.success) {
        alert(`Tip sent! TxID: ${response.txId}`)
      } else {
        alert(`Error: ${response.error}`)
      }
    } catch (err) {
      console.error('Tip error:', err)
      alert(`Error: ${err.message}`)
    }
  }

  function openOptionsButton() {
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage()
    } else {
      window.open(browser.runtime.getURL('options.html'))
    }
  }

  function toggleKeyType(e) {
    e.preventDefault()
    const nextKeyType =
      keys.current[(keys.current.indexOf(pubKey) + 1) % keys.current.length]
    setPubKey(nextKeyType)
  }

  const qrValue = typeof pubKey === 'string' ? (pubKey.startsWith('n') ? pubKey.toUpperCase() : pubKey) : ''

  return (
    <div style={{ marginBottom: '5px' }}>
      <h2>nos2bch</h2>
      {pubKey === null ? (
        <div>
          <button onClick={openOptionsButton}>start here</button>
        </div>
      ) : (
        <>
          <p>
            <a onClick={toggleKeyType}>⩩</a> your public key:
          </p>
          <pre
            className="npub"  // New: Apply .npub class for wrapping
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              width: '200px'
            }}
          >
            <code>{pubKey}</code>
          </pre>

          <div className="qr-container">  {/* New: Apply .qr-container class for responsive QR */}
            <ErrorBoundary>
              {qrValue && (
                <QRCodeSVG
                  value={qrValue}
                  size={256}
                  viewBox="0 0 256 256"
                />
              )}
            </ErrorBoundary>
          </div>

          <div style={{ marginTop: '10px' }}>
            <label>Recipient npub:</label>
            <input
              type="text"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginTop: '5px' }}>
            <label>Amount (sat):</label>
            <input
              type="number"
              value={amountSat}
              onChange={e => setAmountSat(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          <button onClick={handleTip} style={{ marginTop: '10px' }}>Send Tip</button>
        </>
      )}
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Popup />)