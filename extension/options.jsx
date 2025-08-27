import {bytesToHex, hexToBytes} from '@noble/hashes/utils'
import {getPublicKey} from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
import {decrypt, encrypt} from 'nostr-tools/nip49'
import {generateSecretKey} from 'nostr-tools/pure'
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import { QRCodeSVG } from 'qrcode.react'
import browser from 'webextension-polyfill'
import {removePermissions, deriveBCHAddress, getBCHBalance, getTxHistory} from './common'

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    return this.state.hasError ? <div>Error loading options: {this.state.error?.message || 'Unknown error'}</div> : this.props.children;
  }
}

function Options() {
  console.log('Options component rendering...');
  let [unsavedChanges, setUnsavedChanges] = useState([])
  let [privKey, setPrivKey] = useState(null)
  let [privKeyInput, setPrivKeyInput] = useState('')
  let [askPassword, setAskPassword] = useState(null)
  let [password, setPassword] = useState('')
  let [policies, setPermissions] = useState([])
  let [protocolHandler, setProtocolHandler] = useState('https://njump.me/{raw}')
  let [hidingPrivateKey, hidePrivateKey] = useState(true)
  let [showNotifications, setNotifications] = useState(false)
  let [messages, setMessages] = useState([])
  let [handleNostrLinks, setHandleNostrLinks] = useState(false)
  let [showProtocolHandlerHelp, setShowProtocolHandlerHelp] = useState(false)
  let [selectedItems, setSelectedItems] = useState([])
  let [bchAddress, setBchAddress] = useState(null)
  let [bchBalance, setBchBalance] = useState(null)
  let [txHistory, setTxHistory] = useState([])
  let [loading, setLoading] = useState(true)
  let [balanceLoading, setBalanceLoading] = useState(false)
  const showMessage = msg => {
    setMessages(messages => [...messages, msg])
  }
  useEffect(() => {
    if (messages.length === 0) {
      return
    }
    const timeout = setTimeout(() => setMessages([]), 3000)
    return () => clearTimeout(timeout)
  }, [messages, setMessages])
  useEffect(() => {
    (async () => {
      const results = await browser.storage.local.get(['private_key', 'protocol_handler', 'notifications', 'lastBchBalance', 'lastBchBalanceTime']);
      console.log('Options storage loaded:', results);
      if (results.private_key) {
        let prvKey = results.private_key
        let nsec = nip19.nsecEncode(hexToBytes(prvKey))
        setPrivKeyInput(nsec)
        setPrivKey(nsec)
        try {
          let pubHex = getPublicKey(prvKey)
          const address = await deriveBCHAddress(pubHex)
          setBchAddress(address)
          if (results.lastBchBalanceTime && Date.now() - results.lastBchBalanceTime < 600000) {
            setBchBalance(results.lastBchBalance)
          } else {
            refreshBalance(address)
          }
          try {
            const history = await getTxHistory(address)
            setTxHistory(history)
          } catch (err) {
            console.warn('History fetch failed:', err)
            setTxHistory([])
          }
        } catch (err) {
          showMessage('Address derivation failed: ' + err.message)
        }
      } else {
        browser.runtime.openOptionsPage();
      }
      if (results.protocol_handler) {
        setProtocolHandler(results.protocol_handler)
        setHandleNostrLinks(true)
        setShowProtocolHandlerHelp(false)
      }
      if (results.notifications) {
        setNotifications(true)
      }
      setLoading(false)
    })();
  }, [])
  useEffect(() => {
    loadPermissions()
  }, [])
  async function loadPermissions() {
    let {policies = {}} = await browser.storage.local.get('policies')
    let list = []
    Object.entries(policies).forEach(([host, accepts]) => {
      Object.entries(accepts).forEach(([accept, types]) => {
        Object.entries(types).forEach(([type, {conditions, created_at}]) => {
          list.push({
            host,
            type,
            accept,
            conditions,
            created_at
          })
        })
      })
    })
    setPermissions(list)
  }
  async function refreshBalance(address) {
    if (!address) return
    setBalanceLoading(true)
    try {
      let balanceBCH
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          balanceBCH = await getBCHBalance(address)
          break
        } catch (err) {
          console.warn(`Balance fetch attempt ${attempt} failed:`, err)
          if (attempt === 3) throw err
        }
      }
      const sats = Math.floor(balanceBCH * 100000000)
      setBchBalance(sats)
      browser.storage.local.set({lastBchBalance: sats, lastBchBalanceTime: Date.now()})
    } catch (err) {
      setBchBalance(0)
      showMessage('Error loading balance: ' + err.message)
    } finally {
      setBalanceLoading(false)
    }
  }
  async function hideAndResetKeyInput() {
    setPrivKeyInput(privKey)
    hidePrivateKey(true)
  }
  async function handleKeyChange(e) {
    let key = e.target.value.toLowerCase().trim()
    setPrivKeyInput(key)
    try {
      let bytes = hexToBytes(key)
      if (bytes.length === 32) {
        key = nip19.nsecEncode(bytes)
        setPrivKeyInput(key)
      }
    } catch (err) {
      /***/
    }
    if (key.startsWith('ncryptsec1')) {
      // we won't save an encrypted key, will wait for the password
      setAskPassword('decrypt/save')
      return
    }
    try {
      // we will only save a key that is a valid nsec
      if (nip19.decode(key).type === 'nsec') {
        addUnsavedChanges('private_key')
        const pubHex = getPublicKey(bytesToHex(nip19.decode(key).data))
        try {
          const address = await deriveBCHAddress(pubHex) // Await with try/catch
          setBchAddress(address)
        } catch (err) {
          showMessage('Address derivation failed: ' + err.message)
        }
      }
    } catch (err) {
      /***/
    }
  }
  async function generate() {
    let skBytes = generateSecretKey()
    let nsec = nip19.nsecEncode(skBytes)
    setPrivKeyInput(nsec)
    addUnsavedChanges('private_key')
    const pubHex = getPublicKey(skBytes)
    try {
      const address = await deriveBCHAddress(pubHex) // Await with try/catch
      setBchAddress(address)
    } catch (err) {
      showMessage('Address derivation failed: ' + err.message)
    }
  }
  async function saveKey() {
    if (!isKeyValid()) {
      showMessage('PRIVATE KEY IS INVALID! did not save private key.')
      return
    }
    let hexOrEmptyKey = privKeyInput
    try {
      let {type, data} = nip19.decode(privKeyInput)
      if (type === 'nsec') hexOrEmptyKey = bytesToHex(data)
    } catch (_) {}
    await browser.storage.local.set({
      private_key: hexOrEmptyKey
    })
    if (hexOrEmptyKey !== '') {
      setPrivKeyInput(nip19.nsecEncode(hexToBytes(hexOrEmptyKey)))
    }
    showMessage('saved private key!')
  }
  function isKeyValid() {
    if (privKeyInput === '') return true
    try {
      if (nip19.decode(privKeyInput).type === 'nsec') return true
    } catch (_) {}
    return false
  }
  async function handleSelect(index) {
    if (selectedItems.includes(index)) {
      setSelectedItems(selectedItems.filter(i => i !== index))
    } else {
      setSelectedItems([...selectedItems, index])
    }
  }
  function handleNotifications() {
    setNotifications(!showNotifications)
    addUnsavedChanges('notifications')
    if (!showNotifications) requestBrowserNotificationPermissions()
  }
  async function handleMultiRevoke() {
    for (let index of selectedItems) {
      let {host, accept, type} = policies[index]
      await removePermissions(host, accept, type)
    }
    showMessage('removed selected policies')
    loadPermissions()
    setSelectedItems([])
  }
  async function requestBrowserNotificationPermissions() {
    let granted = await browser.permissions.request({
      permissions: ['notifications']
    })
    if (!granted) setNotifications(false)
  }
  async function saveNotifications() {
    await browser.storage.local.set({notifications: showNotifications})
    showMessage('saved notifications!')
  }
  function changeShowProtocolHandlerHelp() {
    setShowProtocolHandlerHelp(true)
  }
  function changeHandleNostrLinks() {
    if (handleNostrLinks) {
      setProtocolHandler('')
      addUnsavedChanges('protocol_handler')
    } else setShowProtocolHandlerHelp(true)
    setHandleNostrLinks(!handleNostrLinks)
  }
  function handleChangeProtocolHandler(e) {
    setProtocolHandler(e.target.value)
    addUnsavedChanges('protocol_handler')
  }
  async function saveNostrProtocolHandlerSettings() {
    await browser.storage.local.set({protocol_handler: protocolHandler})
    showMessage('saved protocol handler!')
  }
  function addUnsavedChanges(section) {
    setUnsavedChanges(currentUnsavedChanges =>
      currentUnsavedChanges.includes(section)
        ? currentUnsavedChanges
        : [...currentUnsavedChanges, section]
    )
  }
  async function saveChanges() {
    for (let section of unsavedChanges) {
      switch (section) {
        case 'private_key':
          await saveKey()
          break
        case 'protocol_handler':
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
      const decryptedKey = decrypt(privKeyInput, password)
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
      const encrypted = encrypt(privKeyInput, password)
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

  const formattedBalance = bchBalance !== null ? bchBalance.toLocaleString() + ' sats' : (balanceLoading ? 'Loading...' : 'Error loading balance');
  const formattedBCH = bchBalance !== null ? (bchBalance / 100000000).toFixed(8) + ' BCH' : '';

  return (
    <>
      <h1 style={{fontSize: '25px', marginBlockEnd: '0px'}}>nos2bch</h1>
      <p style={{marginBlockStart: '0px'}}>nostr signer extension</p>
      {privKey === null && <div style={{marginBottom: '10px'}}>No private key set yet. Generate or enter one below to get started.</div>}
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
                  (bchBalance !== null ? `${formattedBalance} ${formattedBCH ? `(${formattedBCH})` : ''}` : 'Error - <button onClick={() => refreshBalance(bchAddress)}>Retry</button>')}</div>
                <button onClick={() => refreshBalance(bchAddress)} disabled={balanceLoading}>Refresh Balance</button>
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
                  let {data} = nip19.decode(privKey)
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