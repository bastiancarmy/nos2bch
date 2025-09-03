// extension/options.jsx

import {getPublicKey} from 'nostr-tools'
import {nip04} from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
import {hexToBytes} from '@noble/hashes/utils'
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import { QRCodeSVG } from 'qrcode.react'
import browser from 'webextension-polyfill'
import {deriveBCHAddress, refreshBalance, getTxHistory} from './common'

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    return this.state.hasError ? <div>Error: {this.state.error.message}</div> : this.props.children;
  }
}

function Options() {
  const [policies, setPolicies] = useState([])
  const [privKeyInput, setPrivKeyInput] = useState('')
  const [hidingPrivateKey, setHidingPrivateKey] = useState(true)
  const [askPassword, setAskPassword] = useState(null)
  const [password, setPassword] = useState('')
  const [messages, setMessages] = useState([])
  const [handleNostrLinks, setHandleNostrLinks] = useState(false)
  const [protocolHandler, setProtocolHandler] = useState('https://njump.me/{raw}')
  const [showProtocolHandlerHelp, setShowProtocolHandlerHelp] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [unsavedChanges, setUnsavedChanges] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedItems, setSelectedItems] = useState([])
  const [bchAddress, setBchAddress] = useState('')
  const [bchBalance, setBchBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [txHistory, setTxHistory] = useState([])

  useEffect(() => {
    async function load() {
      let {private_key: privKey, nostr_protocol_handler: nostrProtocolHandler, handle_nostr_links: handleNostr, show_protocol_handler_help: showHelp, show_notifications: showNotifs, policies: pol} = await browser.storage.local.get(['private_key', 'nostr_protocol_handler', 'handle_nostr_links', 'show_protocol_handler_help', 'show_notifications', 'policies'])
      setPrivKeyInput(privKey || '')
      setHandleNostrLinks(!!handleNostr)
      setProtocolHandler(nostrProtocolHandler || 'https://njump.me/{raw}')
      setShowProtocolHandlerHelp(!!showHelp)
      setShowNotifications(!!showNotifs)
      setPolicies(Object.entries(pol || {}).flatMap(([host, ans]) => Object.entries(ans.true || {}).map(([type, {conditions, created_at}]) => ({host, type, accept: 'true', conditions, created_at})).concat(Object.entries(ans.false || {}).map(([type, {conditions, created_at}]) => ({host, type, accept: 'false', conditions, created_at})))).sort((a, b) => a.created_at - b.created_at))
      setLoading(false)
      if (privKey) {
        const pub = getPublicKey(privKey)
        const derivedBchAddress = deriveBCHAddress(pub)
        setBchAddress(derivedBchAddress)
        setBalanceLoading(true)
        try {
          const sats = await refreshBalance(derivedBchAddress)
          setBchBalance(sats)
          const history = await getTxHistory(derivedBchAddress)
          setTxHistory(history)
        } catch (err) {
          setBchBalance(0)
          console.error('Error loading balance: ' + err.message)
        } finally {
          setBalanceLoading(false)
        }
      }
    }
    load()
  }, [])

  async function refreshBalanceLocal(address) {
    setBalanceLoading(true)
    try {
      const sats = await refreshBalance(address, true)
      setBchBalance(sats)
      const history = await getTxHistory(address)
      setTxHistory(history)
    } catch (err) {
      setBchBalance(0)
      console.error('Balance refresh failed:', err)
    } finally {
      setBalanceLoading(false)
    }
  }

  function showMessage(msg) {
    setMessages(messages => [...messages, msg])
    setTimeout(() => setMessages(messages => messages.slice(1)), 5000)
  }

  function generate() {
    let sk = generateSecretKey();
    setPrivKeyInput(nip19.nsecEncode(sk));
  }

  function handleKeyChange(ev) {
    setPrivKeyInput(ev.target.value)
    setUnsavedChanges(changes => changes.includes('key') ? changes : [...changes, 'key'])
  }

  function changeHandleNostrLinks(ev) {
    setHandleNostrLinks(ev.target.checked)
    setUnsavedChanges(changes => changes.includes('nostrProtocolHandler') ? changes : [...changes, 'nostrProtocolHandler'])
  }

  function handleChangeProtocolHandler(ev) {
    setProtocolHandler(ev.target.value)
    setUnsavedChanges(changes => changes.includes('nostrProtocolHandler') ? changes : [...changes, 'nostrProtocolHandler'])
  }

  function changeShowProtocolHandlerHelp() {
    setShowProtocolHandlerHelp(!showProtocolHandlerHelp)
    setUnsavedChanges(changes => changes.includes('nostrProtocolHandler') ? changes : [...changes, 'nostrProtocolHandler'])
  }

  function handleNotifications(ev) {
    setShowNotifications(ev.target.checked)
    setUnsavedChanges(changes => changes.includes('notifications') ? changes : [...changes, 'notifications'])
  }

  function hideAndResetKeyInput() {
    hidePrivateKey(true)
    setPrivKeyInput('')
  }

  function hidePrivateKey(hide) {
    setHidingPrivateKey(hide)
  }

  function isKeyValid() {
    try {
      nip19.decode(privKeyInput)
      return true
    } catch (_) {
      return false
    }
  }

  function handleSelect(index) {
    setSelectedItems(prev => prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index])
  }

  async function handleMultiRevoke() {
    for (let index of selectedItems) {
      const policy = policies[index]
      await removePermissions(policy.host, policy.accept, policy.type)
    }
    setSelectedItems([])
    setPolicies(policies.filter((_, i) => !selectedItems.includes(i)))
  }

  async function saveChanges() {
    for (let change of unsavedChanges) {
      switch (change) {
        case 'key':
          await saveKey()
          break
        case 'nostrProtocolHandler':
          await saveNostrProtocolHandlerSettings()
          break
        case 'notifications':
          await saveNotifications()
          break
      }
    }
    setUnsavedChanges([])
  }

  async function decryptPrivateKeyAndSave() {
    try {
      const decryptedKey = nip04.decrypt(privKeyInput, password) // Assuming nip04.decrypt for simplicity; adjust if needed
      const hexKey = bytesToHex(hexToBytes(decryptedKey))
      await browser.storage.local.set({private_key: hexKey})
      setPrivKeyInput(nip19.nsecEncode(hexToBytes(hexKey)))
      setAskPassword(null)
      setPassword('')
      showMessage('Decrypted and saved private key!')
    } catch (err) {
      showMessage('Decryption failed: ' + err.message)
    }
  }

  async function encryptPrivateKeyAndDisplay(ev) {
    ev.preventDefault()
    try {
      const encrypted = nip04.encrypt(privKeyInput, password) // Assuming nip04.encrypt
      setPrivKeyInput(encrypted)
      setAskPassword(null)
      setPassword('')
      showMessage('Encrypted key displayed!')
    } catch (err) {
      showMessage('Encryption failed: ' + err.message)
    }
  }

  if (loading) {
    return <div>Loading options...</div>;
  }

  const formattedBalance = bchBalance !== null ? bchBalance.toLocaleString() + ' sats' : ''
  const formattedBCH = bchBalance !== null ? (bchBalance / 100000000).toFixed(8) + ' BCH' : ''

  return (
    <>
      <h1 style={{fontSize: '25px', marginBlockEnd: '0px'}}>nos2bch</h1>
      <p style={{marginBlockStart: '0px'}}>nostr signer extension</p>
      {privKeyInput === null && <div style={{marginBottom: '10px'}}>No private key set yet. Generate or enter one below to get started.</div>}
      <h2 style={{marginBlockStart: '20px', marginBlockEnd: '5px'}}>options</h2>
      <div
        style={{
          marginBottom: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          width: 'fit-content'
        }}
      >
        <div>
          <div>private key:&nbsp;</div>
          <div
            style={{
              marginLeft: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px'
            }}
          >
            <div style={{display: 'flex', gap: '10px'}}>
              <input
                type={hidingPrivateKey ? 'password' : 'text'}
                style={{width: '600px'}}
                value={privKeyInput}
                onChange={handleKeyChange}
              />
              {privKeyInput === '' && (
                <button onClick={generate}>generate</button>
              )}
              {privKeyInput && hidingPrivateKey && (
                <>
                  {askPassword !== 'encrypt/display' && (
                    <button onClick={() => hidePrivateKey(false)}>
                      show key
                    </button>
                  )}
                  <button onClick={() => setAskPassword('encrypt/display')}>
                    show key encrypted
                  </button>
                </>
              )}
              {privKeyInput && !hidingPrivateKey && (
                <button onClick={hideAndResetKeyInput}>hide key</button>
              )}
            </div>
            {privKeyInput &&
              !privKeyInput.startsWith('ncryptsec1') &&
              !isKeyValid() && (
                <div style={{color: 'red'}}>private key is invalid!</div>
              )}
            {!hidingPrivateKey &&
              privKeyInput !== '' &&
              (privKeyInput.startsWith('ncryptsec1') || isKeyValid()) && (
                <QRCodeSVG
                  value={privKeyInput.toUpperCase()}
                  size={256}
                  level="H"
                  style={{margin: '10px 0'}}
                />
              )}
            {bchAddress && (
              <div>
                <div>BCH Address (from npub): {bchAddress}</div>
                <QRCodeSVG
                  value={bchAddress.toUpperCase()}
                  size={256}
                  level="H"
                  style={{margin: '10px 0'}}
                />
                <div>BCH Balance: {balanceLoading ? <span>Loading... <span className="spinner" /></span> :
                  (bchBalance !== null ? `${formattedBalance} ${formattedBCH ? `(${formattedBCH})` : ''}` : 
                    <span>Error - <button onClick={async () => { setBalanceLoading(true); try { const sats = await refreshBalance(bchAddress, true); setBchBalance(sats); } catch (err) { setBchBalance(0); console.error('Error: ' + err.message); } finally { setBalanceLoading(false); }}}>Retry</button></span>)}</div>
                <button onClick={() => refreshBalanceLocal(bchAddress)} disabled={balanceLoading}>Refresh Balance</button>
              </div>
            )}
            {bchAddress && (
              <div>
                <h3>Transaction History</h3>
                {txHistory.length === 0 ? <div>No transactions</div> : (
                  <ul>
                    {txHistory.map(tx => (
                      <li key={tx.hash}>
                        <a href={`https://blockchair.com/bitcoin-cash/transaction/${tx.hash}`} target="_blank">
                          {tx.hash} - {tx.balance_change} sat
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
        {askPassword && (
          <div>
            <div>password:&nbsp;</div>
            <div
              style={{
                marginLeft: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}
            >
              <form
                style={{display: 'flex', flexDirection: 'row', gap: '10px'}}
              >
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={ev => setPassword(ev.target.value)}
                  style={{width: '150px'}}
                />
                {askPassword === 'decrypt/save' ? (
                  <button
                    onClick={decryptPrivateKeyAndSave}
                    disabled={!password}
                  >
                    decrypt key
                  </button>
                ) : askPassword === 'encrypt/display' ? (
                  <button
                    onClick={ev => {
                      console.log('gah')
                      encryptPrivateKeyAndDisplay(ev)
                    }}
                    disabled={!password}
                  >
                    encrypt and show key
                  </button>
                ) : (
                  'jaksbdkjsad'
                )}
              </form>
            </div>
          </div>
        )}
        <div>
          <div>nosta.me:&nbsp;</div>
          <div
            style={{
              marginLeft: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px'
            }}
          >
            <div style={{display: 'flex', gap: '10px'}}>
              <button
                onClick={() => {
                  let {data} = nip19.decode(privKeyInput)
                  let pub = getPublicKey(data)
                  let npub = nip19.npubEncode(pub)
                  window.open('https://nosta.me/' + npub)
                }}
                style={{cursor: 'pointer'}}
              >
                browse your profile
              </button>
              <button
                onClick={() => window.open('https://nosta.me/login/options')}
                style={{cursor: 'pointer'}}
              >
                edit your profile
              </button>
            </div>
          </div>
        </div>
        <div>
          <label style={{display: 'flex', alignItems: 'center'}}>
            <div>
              handle{' '}
              <span style={{padding: '2px', background: 'silver'}}>nostr:</span>{' '}
              links:
            </div>
            <input
              type="checkbox"
              checked={handleNostrLinks}
              onChange={changeHandleNostrLinks}
            />
          </label>
          <div style={{marginLeft: '10px'}}>
            {handleNostrLinks && (
              <div>
                <div style={{display: 'flex'}}>
                  <input
                    placeholder="url template"
                    value={protocolHandler}
                    onChange={handleChangeProtocolHandler}
                    style={{width: '680px', maxWidth: '90%'}}
                  />
                  {!showProtocolHandlerHelp && (
                    <button onClick={changeShowProtocolHandlerHelp}>?</button>
                  )}
                </div>
                {showProtocolHandlerHelp && (
                  <pre>{`
    {raw} = anything after the colon, i.e. the full nip19 bech32 string
    {hex} = hex pubkey for npub or nprofile, hex event id for note or nevent
    {p_or_e} = "p" for npub or nprofile, "e" for note or nevent
    {u_or_n} = "u" for npub or nprofile, "n" for note or nevent
    {relay0} = first relay in a nprofile or nevent
    {relay1} = second relay in a nprofile or nevent
    {relay2} = third relay in a nprofile or nevent
    {hrp} = human-readable prefix of the nip19 string
    examples:
      - https://njump.me/{raw}
      - https://snort.social/{raw}
      - https://nostr.band/{raw}
                `}</pre>
                )}
              </div>
            )}
          </div>
        </div>
        <label style={{display: 'flex', alignItems: 'center'}}>
          show notifications when permissions are used:
          <input
            type="checkbox"
            checked={showNotifications}
            onChange={handleNotifications}
          />
        </label>
        <button
          disabled={!unsavedChanges.length}
          onClick={saveChanges}
          style={{padding: '5px 20px'}}
        >
          save
        </button>
        <div style={{fontSize: '120%'}}>
          {messages.map((message, i) => (
            <div key={i}>{message}</div>
          ))}
        </div>
      </div>
      <div>
        <h2>permissions</h2>
        {!!policies.length && (
          <div style={{display: 'flex'}}>
            <table>
              <thead>
                <tr>
                  <th>domain</th>
                  <th>permission</th>
                  <th>answer</th>
                  <th>conditions</th>
                  <th>since</th>
                  <th>revoke</th>
                </tr>
              </thead>
              <tbody>
                {policies.map(
                  ({host, type, accept, conditions, created_at}, index) => (
                    <tr key={host + type + accept + JSON.stringify(conditions)}>
                      <td>{host}</td>
                      <td>{type}</td>
                      <td>{accept === 'true' ? 'allow' : 'deny'}</td>
                      <td>
                        {conditions.kinds
                          ? `kinds: ${Object.keys(conditions.kinds).join(', ')}`
                          : 'always'}
                      </td>
                      <td>
                        {new Date(created_at * 1000)
                          .toISOString()
                          .split('.')[0]
                          .split('T')
                          .join(' ')}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedItems.includes(index)}
                          onChange={() => handleSelect(index)}
                          data-host={host}
                          data-accept={accept}
                          data-type={type}
                        />
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
            {selectedItems.length > 0 ? (
              <button
                style={{marginLeft: '0.5rem'}}
                onClick={handleMultiRevoke}
              >
                revoke
              </button>
            ) : null}
          </div>
        )}
        {!policies.length && (
          <div style={{marginTop: '5px'}}>
            no permissions have been granted yet
          </div>
        )}
      </div>
    </>
  )
}

createRoot(document.getElementById('main')).render(
  <ErrorBoundary>
    <Options />
  </ErrorBoundary>
);