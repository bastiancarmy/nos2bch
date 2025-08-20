// extension/prompt.jsx (updated to handle tipBCH with custom display and conditions)
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'

function Prompt() {
  const params = new URLSearchParams(location.search)
  const host = params.get('host')
  const type = params.get('type')
  const [kinds, setKinds] = useState([])
  const [maxSat, setMaxSat] = useState(params.get('amountSat') || '0')

  // For sign_event kinds (unchanged)
  useEffect(() => {
    if (type === 'sign_event') {
      setKinds([0, 1, 3, 4, 6, 7])
    }
  }, [type])

  function respond(accept, always) {
    const conditions = always ? getConditions(accept) : null
    browser.runtime.sendMessage({
      prompt: true,
      type,
      host,
      accept: accept.toString(),
      conditions
    })
    window.close()
  }

  function getConditions(accept) {
    if (type === 'tipBCH') {
      const max = parseInt(maxSat) || -1
      return {maxSat: max}
    } else if (type === 'sign_event') {
      const selected = {}
      kinds.forEach(kind => { selected[kind] = true })
      return {kinds: selected}
    }
    return null
  }

  function toggleKind(kind) {
    setKinds(kinds.includes(kind) ? kinds.filter(k => k !== kind) : [...kinds, kind])
  }

  return (
    <div>
      <h1>{host} wants to:</h1>
      <h2>{type.replaceAll('_', ' ')}</h2>
      {type === 'tipBCH' && (
        <div>
          Send {params.get('amountSat')} sats to {params.get('recipientNpub')}.<br />
          Estimated fee: {params.get('estFee')} sats.<br />
          Estimated change: {params.get('estChange')} sats.
        </div>
      )}
      {type === 'sign_event' && (
        <div>
          for kinds:
          {[0, 1, 3, 4, 6, 7].map(kind => (
            <label key={kind}>
              <input type="checkbox" checked={kinds.includes(kind)} onChange={() => toggleKind(kind)} />
              {kind}
            </label>
          ))}
        </div>
      )}
      {(type === 'tipBCH' || type === 'sign_event') && (
        <div>
          When allowing always:
          {type === 'tipBCH' && (
            <label>
              Max amount without prompt: <input type="number" value={maxSat} onChange={e => setMaxSat(e.target.value)} /> sats (0 for unlimited)
            </label>
          )}
          {type === 'sign_event' && <div>for selected kinds above</div>}
        </div>
      )}
      <div className="buttons">
        <button className="outline" onClick={() => respond(false, false)}>deny once</button>
        <button className="outline" onClick={() => respond(false, true)}>deny always</button>
        <button className="outline" onClick={() => respond(true, true)}>allow always</button>
        <button onClick={() => respond(true, false)}>allow once</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Prompt />)