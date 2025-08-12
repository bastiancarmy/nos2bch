// extension/prompt.jsx
import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'

function Prompt() {
  let qs = new URLSearchParams(window.location.search)
  let host = qs.get('host')
  let id = qs.get('id')
  let type = qs.get('type')
  let params = JSON.parse(qs.get('params'))
  let result = qs.get('result')
  let details = JSON.parse(qs.get('details') || '{}')
  let [accept, setAccept] = useState(false)
  let [always, setAlways] = useState(false)
  let [kinds, setKinds] = useState({})
  let [maxAmount, setMaxAmount] = useState(1000)

  function toggleAlways() {
    setAlways(!always)
  }

  function toggleKind(kind) {
    setKinds({
      ...kinds,
      [kind]: !kinds[kind]
    })
  }

  function respond(accept) {
    let conditions = null
    if (always) {
      if (type === 'signEvent') {
        conditions = {kinds: kinds}
      } else if (type === 'tipBCH') {
        conditions = {max_amount: maxAmount}
      }
    }
    browser.runtime.sendMessage({
      prompt: true,
      type,
      host,
      accept,
      conditions
    })
  }

  let isSignEvent = type === 'signEvent'
  let isTipBCH = type === 'tipBCH'
  let event = isSignEvent ? params.event : null

  return (
    <div style={{padding: '20px'}}>
      <h1>{host} wants to:</h1>
      <h2>{type.replace('.', ' ')}</h2>
      {result && <pre>{result}</pre>}
      {isSignEvent && (
        <div>
          <pre>{JSON.stringify(event, null, 2)}</pre>
          <label>
            <input type="checkbox" checked={always} onChange={toggleAlways} />
            always allow for these kinds
          </label>
          {always && (
            <div>
              <label>
                <input type="checkbox" checked={kinds[event.kind]} onChange={() => toggleKind(event.kind)} />
                kind {event.kind}
              </label>
            </div>
          )}
        </div>
      )}
      {isTipBCH && (
        <div>
          <div>Send {details.amountSat} sat to {details.recipientNpub} ({details.recipientAddress})</div>
          <div>Fee: {details.feeSat} sat</div>
          <div>Change: {details.changeSat} sat</div>
          <label>
            <input type="checkbox" checked={always} onChange={toggleAlways} />
            always allow up to 
            <input type="number" value={maxAmount} onChange={e => setMaxAmount(parseInt(e.target.value))} style={{width: '80px', marginLeft: '5px'}} /> sat
          </label>
        </div>
      )}
      <div style={{display: 'flex', gap: '10px', marginTop: '20px'}}>
        <button onClick={() => respond(true)}>accept</button>
        <button onClick={() => respond(false)}>reject</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Prompt />)