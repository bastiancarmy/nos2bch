import {bytesToHex, hexToBytes} from '@noble/hashes/utils'
import {getPublicKey} from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
import {decrypt, encrypt} from 'nostr-tools/nip49'
import {generateSecretKey} from 'nostr-tools/pure'
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {QRCodeSVG} from 'qrcode.react'
import browser from 'webextension-polyfill'
import {removePermissions, getBCHBalance, deriveBCHAddress, getTxHistory} from './common'

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    return this.state.hasError ? <div>Error: {this.state.error.message}</div> : this.props.children;
  }
}

function Options() {
  const [unsavedChanges, setUnsavedChanges] = useState([])
  const [privKey, setPrivKey] = useState(null)
  const [privKeyInput, setPrivKeyInput] = useState('')
  const [hidingPrivateKey, setHidingPrivateKey] = useState(true)
  const [askPassword, setAskPassword] = useState(null)
  const [password, setPassword] = useState('')
  const [policies, setPolicies] = useState([])
  const [protocolHandler, setProtocolHandler] = useState('https://njump.me/{raw}')
  const [showNotifications, setShowNotifications] = useState(false)
  const [messages, setMessages] = useState([])
  const [handleNostrLinks, setHandleNostrLinks] = useState(false)
  const [showProtocolHandlerHelp, setShowProtocolHandlerHelp] = useState(false)
  const [selectedItems, setSelectedItems] = useState([])
  const [bchAddress, setBchAddress] = useState('')
  const [bchBalance, setBchBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [txHistory, setTxHistory] = useState([])

  const showMessage = msg => {
    setMessages(messages => [...messages, msg])
    setTimeout(() => setMessages(messages => messages.slice(1)), 5000)
  }

  useEffect(() => {
    console.log('Loading storage...'); // Debug
    async function load() {
      let {private_key, nostr_protocol_handler, handle_nostr_links, show_notifications, policies} = await browser.storage.local.get(['private_key', 'nostr_protocol_handler', 'handle_nostr_links', 'show_notifications', 'policies']);
      console.log('Storage results:', {private_key, nostr_protocol_handler, handle_nostr_links, show_notifications, policies}); // Debug
      if (private_key) {
        const nsec = nip19.nsecEncode(hexToBytes(private_key));
        setPrivKeyInput(nsec);
        setPrivKey(nsec);
        const pub = getPublicKey(hexToBytes(private_key));
        const derivedBchAddress = deriveBCHAddress(pub);
        setBchAddress(derivedBchAddress);
        setBalanceLoading(true);
        try {
          const bchValue = await getBCHBalance(derivedBchAddress);
          console.log('Raw balance from getBCHBalance:', bchValue); // Debug
          const sats = bchValue * 100000000; // Convert BCH to sats
          setBchBalance(sats);
          const history = await getTxHistory(derivedBchAddress);
          setTxHistory(history);
        } catch (err) {
          setBchBalance(null);
          showMessage('Error loading balance: ' + err.message);
        } finally {
          setBalanceLoading(false);
        }
      }
      setHandleNostrLinks(!!handle_nostr_links);
      setProtocolHandler(nostr_protocol_handler || 'https://njump.me/{raw}');
      setShowNotifications(!!show_notifications);
      setPolicies(Object.entries(policies || {}).flatMap(([host, ans]) =>
        Object.entries(ans.true || {}).map(([type, {conditions, created_at}]) => ({host, type, accept: 'true', conditions, created_at}))
        .concat(Object.entries(ans.false || {}).map(([type, {conditions, created_at}]) => ({host, type, accept: 'false', conditions, created_at})))
      ).sort((a, b) => a.created_at - b.created_at));
    }
    load().catch(err => console.error('Load error:', err));
    console.log('Imports:', { generateSecretKey, nip19, encrypt, decrypt }); // Debug
  }, []);

  useEffect(() => {
    async function loadPermissions() {
      let {policies = {}} = await browser.storage.local.get('policies');
      setPolicies(Object.entries(policies).flatMap(([host, ans]) =>
        Object.entries(ans.true || {}).map(([type, {conditions, created_at}]) => ({host, type, accept: 'true', conditions, created_at}))
        .concat(Object.entries(ans.false || {}).map(([type, {conditions, created_at}]) => ({host, type, accept: 'false', conditions, created_at})))
      ).sort((a, b) => a.created_at - b.created_at));
    }
    loadPermissions();
  }, []);

  async function refreshBalanceLocal(address) {
    setBalanceLoading(true);
    try {
      const bchValue = await getBCHBalance(address, true);
      console.log('Raw balance from getBCHBalance (refresh):', bchValue); // Debug
      const sats = bchValue * 100000000; // Convert BCH to sats
      setBchBalance(sats);
      const history = await getTxHistory(address);
      setTxHistory(history);
    } catch (err) {
      setBchBalance(null);
      showMessage('Balance refresh failed: ' + err.message);
    } finally {
      setBalanceLoading(false);
    }
  }

  function hideAndResetKeyInput() {
    setPrivKeyInput(privKey || '');
    setHidingPrivateKey(true);
  }

  function handleKeyChange(ev) {
    let key = ev.target.value.toLowerCase().trim();
    setPrivKeyInput(key);
    setUnsavedChanges(changes => changes.includes('key') ? changes : [...changes, 'key']);
    try {
      let bytes = hexToBytes(key);
      if (bytes.length === 32) {
        key = nip19.nsecEncode(bytes);
        setPrivKeyInput(key);
      }
    } catch (err) {}
    if (key.startsWith('ncryptsec1')) {
      setAskPassword('decrypt/save');
      return;
    }
    try {
      if (nip19.decode(key).type === 'nsec') {
        const pub = getPublicKey(nip19.decode(key).data);
        const address = deriveBCHAddress(pub);
        setBchAddress(address);
        refreshBalanceLocal(address);
      } else {
        setBchAddress('');
        setBchBalance(null);
      }
    } catch (err) {
      setBchAddress('');
      setBchBalance(null);
    }
  }

  function generate() {
    try {
      const sk = generateSecretKey();
      console.log('Generated key:', sk); // Debug
      setPrivKeyInput(nip19.nsecEncode(sk));
      setUnsavedChanges(changes => changes.includes('key') ? changes : [...changes, 'key']);
      const pub = getPublicKey(sk);
      const address = deriveBCHAddress(pub);
      setBchAddress(address);
      refreshBalanceLocal(address);
    } catch (err) {
      showMessage('Error generating key: ' + err.message);
    }
  }

  function encryptPrivateKeyAndDisplay(ev) {
    ev.preventDefault();
    try {
      let {data} = nip19.decode(privKeyInput);
      let encrypted = encrypt(data, password, 16, 0x00);
      setPrivKeyInput(encrypted);
      setHidingPrivateKey(false);
      setAskPassword(null);
      setPassword('');
      showMessage('Encrypted key displayed!');
    } catch (e) {
      showMessage('Encryption failed: ' + e.message);
    }
  }

  function decryptPrivateKeyAndSave() {
    try {
      const decrypted = decrypt(privKeyInput, password);
      setPrivKeyInput(nip19.nsecEncode(decrypted));
      browser.storage.local.set({private_key: bytesToHex(decrypted)});
      setPrivKey(nip19.nsecEncode(decrypted));
      setAskPassword(null);
      setPassword('');
      const pub = getPublicKey(decrypted);
      const address = deriveBCHAddress(pub);
      setBchAddress(address);
      refreshBalanceLocal(address);
      showMessage('Decrypted and saved private key!');
    } catch (e) {
      showMessage('Decryption failed: ' + e.message);
    }
  }

  async function saveKey() {
    if (!isKeyValid()) {
      showMessage('PRIVATE KEY IS INVALID! Did not save private key.');
      return;
    }
    let hexOrEmptyKey = privKeyInput;
    try {
      let {type, data} = nip19.decode(privKeyInput);
      if (type === 'nsec') hexOrEmptyKey = bytesToHex(data);
    } catch (_) {}
    try {
      await browser.storage.local.set({private_key: hexOrEmptyKey});
      if (hexOrEmptyKey !== '') {
        setPrivKey(nip19.nsecEncode(hexToBytes(hexOrEmptyKey)));
        setPrivKeyInput(nip19.nsecEncode(hexToBytes(hexOrEmptyKey)));
      }
      showMessage('Saved private key!');
    } catch (err) {
      showMessage('Error saving key: ' + err.message);
    }
  }

  function isKeyValid() {
    if (privKeyInput === '') return true;
    try {
      return nip19.decode(privKeyInput).type === 'nsec';
    } catch (_) {
      return false;
    }
  }

  function handleSelect(index) {
    setSelectedItems(prev => prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]);
  }

  function handleNotifications(ev) {
    setShowNotifications(ev.target.checked);
    setUnsavedChanges(changes => changes.includes('notifications') ? changes : [...changes, 'notifications']);
    if (ev.target.checked) requestBrowserNotificationPermissions();
  }

  async function handleMultiRevoke() {
    for (let index of selectedItems) {
      const policy = policies[index];
      await removePermissions(policy.host, policy.accept, policy.type);
    }
    setSelectedItems([]);
    setPolicies(policies.filter((_, i) => !selectedItems.includes(i)));
    showMessage('Removed selected policies');
  }

  async function requestBrowserNotificationPermissions() {
    let granted = await browser.permissions.request({permissions: ['notifications']});
    if (!granted) setShowNotifications(false);
  }

  async function saveNotifications() {
    await browser.storage.local.set({show_notifications: showNotifications});
    showMessage('Saved notifications!');
  }

  function changeShowProtocolHandlerHelp() {
    setShowProtocolHandlerHelp(!showProtocolHandlerHelp);
    setUnsavedChanges(changes => changes.includes('nostrProtocolHandler') ? changes : [...changes, 'nostrProtocolHandler']);
  }

  function changeHandleNostrLinks(ev) {
    setHandleNostrLinks(ev.target.checked);
    setUnsavedChanges(changes => changes.includes('nostrProtocolHandler') ? changes : [...changes, 'nostrProtocolHandler']);
  }

  function handleChangeProtocolHandler(ev) {
    setProtocolHandler(ev.target.value);
    setUnsavedChanges(changes => changes.includes('nostrProtocolHandler') ? changes : [...changes, 'nostrProtocolHandler']);
  }

  async function saveNostrProtocolHandlerSettings() {
    await browser.storage.local.set({
      nostr_protocol_handler: protocolHandler,
      handle_nostr_links: handleNostrLinks
    });
    showMessage('Saved protocol handler!');
  }

  async function saveChanges() {
    for (let change of unsavedChanges) {
      switch (change) {
        case 'key':
          await saveKey();
          break;
        case 'nostrProtocolHandler':
          await saveNostrProtocolHandlerSettings();
          break;
        case 'notifications':
          await saveNotifications();
          break;
      }
    }
    setUnsavedChanges([]);
  }

  const formattedBalance = bchBalance !== null ? bchBalance.toLocaleString() + ' sats' : '';

  return (
    <>
      <h1 style={{fontSize: '25px', marginBlockEnd: '0px'}}>nos2bch</h1>
      <p style={{marginBlockStart: '0px'}}>nostr signer extension</p>
      {privKeyInput === null && <div style={{marginBottom: '10px'}}>No private key set yet. Generate or enter one below to get started.</div>}
      <h2 style={{marginBlockStart: '20px', marginBlockEnd: '5px'}}>options</h2>
      <div style={{marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '10px', width: 'fit-content'}}>
        <div>
          <div>private key:&nbsp;</div>
          <div style={{marginLeft: '10px', display: 'flex', flexDirection: 'column', gap: '10px'}}>
            <div style={{display: 'flex', gap: '10px'}}>
              <input
                type={hidingPrivateKey ? 'password' : 'text'}
                style={{width: '600px'}}
                value={privKeyInput}
                onChange={handleKeyChange}
              />
              {privKeyInput === '' && <button onClick={generate}>generate</button>}
              {privKeyInput && hidingPrivateKey && (
                <>
                  {askPassword !== 'encrypt/display' && <button onClick={() => setHidingPrivateKey(false)}>show key</button>}
                  <button onClick={() => setAskPassword('encrypt/display')}>show key encrypted</button>
                </>
              )}
              {privKeyInput && !hidingPrivateKey && <button onClick={hideAndResetKeyInput}>hide key</button>}
            </div>
            {privKeyInput && !privKeyInput.startsWith('ncryptsec1') && !isKeyValid() && (
              <div style={{color: 'red'}}>private key is invalid!</div>
            )}
            {!hidingPrivateKey && privKeyInput !== '' && (privKeyInput.startsWith('ncryptsec1') || isKeyValid()) && (
              <QRCodeSVG value={privKeyInput.toUpperCase()} size={256} level="H" style={{margin: '10px 0'}} />
            )}
            {bchAddress && (
              <div>
                <div>BCH Address (from npub): {bchAddress}</div>
                <QRCodeSVG value={bchAddress.toUpperCase()} size={256} level="H" style={{margin: '10px 0'}} />
                <div>
                  BCH Balance: {balanceLoading ? <span>Loading... <span className="spinner" /></span> :
                    (bchBalance !== null ? formattedBalance :
                      <span>Error - <button onClick={() => refreshBalanceLocal(bchAddress)}>Retry</button></span>)}
                </div>
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
                          {tx.hash} - {tx.balance_change || 'N/A'} sat
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
            <div style={{marginLeft: '10px', display: 'flex', flexDirection: 'column', gap: '10px'}}>
              <form style={{display: 'flex', flexDirection: 'row', gap: '10px'}}>
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={ev => setPassword(ev.target.value)}
                  style={{width: '150px'}}
                />
                {askPassword === 'decrypt/save' ? (
                  <button onClick={decryptPrivateKeyAndSave} disabled={!password}>decrypt key</button>
                ) : askPassword === 'encrypt/display' ? (
                  <button onClick={encryptPrivateKeyAndDisplay} disabled={!password}>encrypt and show key</button>
                ) : null}
              </form>
            </div>
          </div>
        )}
        <div>
          <div>nosta.me:&nbsp;</div>
          <div style={{marginLeft: '10px', display: 'flex', flexDirection: 'column', gap: '10px'}}>
            <div style={{display: 'flex', gap: '10px'}}>
              <button
                onClick={() => {
                  let {data} = nip19.decode(privKeyInput);
                  let pub = getPublicKey(data);
                  let npub = nip19.npubEncode(pub);
                  window.open('https://nosta.me/' + npub);
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
              handle <span style={{padding: '2px', background: 'silver'}}>nostr:</span> links:
            </div>
            <input type="checkbox" checked={handleNostrLinks} onChange={changeHandleNostrLinks} />
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
                  {!showProtocolHandlerHelp && <button onClick={changeShowProtocolHandlerHelp}>?</button>}
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
          <input type="checkbox" checked={showNotifications} onChange={handleNotifications} />
        </label>
        <button disabled={!unsavedChanges.length} onClick={saveChanges} style={{padding: '5px 20px'}}>save</button>
        <div style={{fontSize: '120%'}}>
          {messages.map((message, i) => <div key={i}>{message}</div>)}
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
                {policies.map(({host, type, accept, conditions, created_at}, index) => (
                  <tr key={host + type + accept + JSON.stringify(conditions)}>
                    <td>{host}</td>
                    <td>{type}</td>
                    <td>{accept === 'true' ? 'allow' : 'deny'}</td>
                    <td>{conditions.kinds ? `kinds: ${Object.keys(conditions.kinds).join(', ')}` : 'always'}</td>
                    <td>{new Date(created_at * 1000).toISOString().split('.')[0].split('T').join(' ')}</td>
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
                ))}
              </tbody>
            </table>
            {selectedItems.length > 0 ? <button style={{marginLeft: '0.5rem'}} onClick={handleMultiRevoke}>revoke</button> : null}
          </div>
        )}
        {!policies.length && <div style={{marginTop: '5px'}}>no permissions have been granted yet</div>}
      </div>
    </>
  )
}

createRoot(document.getElementById('main')).render(
  <ErrorBoundary>
    <Options />
  </ErrorBoundary>
);